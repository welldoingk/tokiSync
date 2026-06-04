/**
 * 상태 저장소 — 명령 로그(command log) + 유저스크립트 리포트 + 캡차 로그 + 작업 풀(units/lease).
 *
 * 두 가지 운영 모드를 동시에 지원한다(하위호환):
 *  1) 레거시 단일 클라 모드(`/queue` 명령 스트림):
 *     - 대시보드가 명령(add/start/stop/clear/remove)을 append → 각 명령에 단조 증가 seq 부여.
 *     - 유저스크립트가 `GET /queue?since=<seq>` 폴링 → seq보다 큰 명령만 받아 적용.
 *     - 유저스크립트가 `POST /progress`로 로컬 큐/실행상태/진행률을 리포트(미러).
 *  2) 멀티-IP lease 모드(`/jobs` `/lease` `/complete` `/clients`):
 *     - 대시보드가 작업(회차 URL들)을 `units` 풀에 enqueue(멱등).
 *     - 클라이언트(clientId)가 `/lease`로 pending unit을 원자적으로 임대(만료시각 부여).
 *     - `/complete`로 done/failed 보고(실패→pending 재투입, attempts++, 상한 시 failed 격리).
 *     - lease TTL 만료(클라 죽음/캡차/오프라인) → 자동 pending 복귀 → 다른 클라가 가져감.
 *  - 캡차 감지는 별도 로그 + 텔레그램 트리거.
 *
 * 디스크 영속화(JSON): seq/unitSeq/commands/units/captcha만 저장(재시작 후 작업 풀 복원).
 *  - report/reports(진행률 미러)는 휘발성 — 폴링 주기마다 재생성되므로 디스크에 쓰지 않는다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeUrlKey, urlLabel } from './util.js';

const MAX_COMMANDS = 200;
const MAX_CAPTCHA = 50;
const MAX_CLIENT_LOGS = 200;             // 클라이언트별 로그 ring 상한(휘발성, 대시보드 표시용)
const MAX_EXPANSIONS = 1000;             // 보관할 최근 expand 요청 수(구독 일괄 업데이트 시 누락 방지)
const EXPANSION_TTL_MS = 15 * 60 * 1000; // expand 요청 유효 시간(15분) — 이후 자동 만료
const MAX_UNITS = 5000;                 // 작업 풀 상한 — 초과 시 오래된 done/failed부터 정리
const MAX_ATTEMPTS = 3;                  // attempts 상한 도달 시 failed 격리(무한 재투입 방지)
const DEFAULT_LEASE_TTL_MS = 120000;     // lease 기본 TTL(2분) — 만료 시 자동 pending 복귀

export class Store {
    constructor(dataFile) {
        this.dataFile = dataFile || '';
        this.state = {
            seq: 0,
            unitSeq: 0,
            expSeq: 0,
            clearSeq: 0, // /jobs/clear 시 증가 → 클라가 heartbeat 로 감지해 로컬 큐/워커 정리
            paused: false, // true면 /lease가 빈 배열 반환(새 작업 중단), 클라는 stopQueue
            commands: [],
            units: [],
            expansions: [], // 작품 메인 URL → 회차 자동 펼침 요청(클라이언트가 처리)
            subscriptions: [], // [{seriesUrl, series, category, addedAt, lastRun, lastNew, lastStatus, enabled}] 자동 업데이트 구독
            cron: { expr: '0 4 * * *', enabled: false, lastRun: 0 }, // 스케줄(기본 매일 04:00, 기본 비활성)
            report: { queue: [], running: false, progress: null, ts: 0 }, // 레거시 단일 슬롯(휘발성)
            reports: {}, // clientId → 리포트 맵(휘발성)
            captcha: [],
        };
        this._unitKeys = new Set(); // 멱등 enqueue용 정규화 url 키 집합
        this._load();
    }

    _load() {
        try {
            if (this.dataFile && existsSync(this.dataFile)) {
                const raw = JSON.parse(readFileSync(this.dataFile, 'utf8'));
                this.state = {
                    seq: Number(raw.seq) || 0,
                    unitSeq: Number(raw.unitSeq) || 0,
                    expSeq: Number(raw.expSeq) || 0,
                    clearSeq: Number(raw.clearSeq) || 0,
                    paused: !!raw.paused,
                    commands: Array.isArray(raw.commands) ? raw.commands : [],
                    units: Array.isArray(raw.units) ? raw.units : [],
                    expansions: Array.isArray(raw.expansions) ? raw.expansions : [],
                    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
                    cron:
                        raw.cron && typeof raw.cron === 'object'
                            ? {
                                  expr: typeof raw.cron.expr === 'string' ? raw.cron.expr : '0 4 * * *',
                                  enabled: !!raw.cron.enabled,
                                  lastRun: Number(raw.cron.lastRun) || 0,
                              }
                            : { expr: '0 4 * * *', enabled: false, lastRun: 0 },
                    report: { queue: [], running: false, progress: null, ts: 0 },
                    reports: {},
                    captcha: Array.isArray(raw.captcha) ? raw.captcha : [],
                };
                // unitSeq 보정: 영속 데이터가 누락/손상돼도 id 충돌이 없도록 최대 id 기준 복원
                let maxSeq = this.state.unitSeq;
                for (const u of this.state.units) {
                    if (u && u.key) this._unitKeys.add(u.key);
                    const n = u && typeof u.id === 'string' ? parseInt(u.id.replace(/^u/, ''), 10) : 0;
                    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
                }
                this.state.unitSeq = maxSeq;
            }
        } catch (e) {
            console.error('[store] load failed:', e.message);
        }
    }

    _persist() {
        if (!this.dataFile) return;
        try {
            mkdirSync(dirname(this.dataFile), { recursive: true });
            // report/reports(휘발성)는 제외하고 저장
            const { seq, unitSeq, expSeq, clearSeq, paused, commands, units, expansions, subscriptions, cron, captcha } =
                this.state;
            writeFileSync(
                this.dataFile,
                JSON.stringify(
                    { seq, unitSeq, expSeq, clearSeq, paused, commands, units, expansions, subscriptions, cron, captcha },
                    null,
                    2
                )
            );
        } catch (e) {
            console.error('[store] persist failed:', e.message);
        }
    }

    // ── 레거시 단일 클라 모드 (명령 스트림) ───────────────────────────────

    addCommand(type, payload, now) {
        const seq = ++this.state.seq;
        this.state.commands.push({ seq, type, payload: payload || null, ts: now });
        if (this.state.commands.length > MAX_COMMANDS) {
            this.state.commands = this.state.commands.slice(-MAX_COMMANDS);
        }
        this._persist();
        return seq;
    }

    commandsSince(since) {
        const s = Number.isFinite(since) ? since : -1;
        return this.state.commands.filter((c) => c.seq > s);
    }

    setReport(report, now) {
        // 진행률 미러는 폴링 주기(수 초)마다 들어오는 휘발성 상태 → 디스크에 매번 쓰지 않는다.
        // (다음 폴링에서 곧바로 재생성되므로 재시작 후 유실돼도 무방. 동기 I/O 부하 회피.)
        this.state.report = {
            queue: Array.isArray(report.queue) ? report.queue : [],
            running: !!report.running,
            progress: report.progress ?? null,
            ts: now,
        };
    }

    addCaptcha(message, url, now) {
        this.state.captcha.push({ ts: now, message: message || '', url: url || '' });
        if (this.state.captcha.length > MAX_CAPTCHA) {
            this.state.captcha = this.state.captcha.slice(-MAX_CAPTCHA);
        }
        this._persist();
    }

    // ── 작품 자동 펼침(expand) — 메인 URL → 클라이언트가 회차 목록 추출해 /jobs 투입 ──
    //   Cloudflare 때문에 서버는 회차 목록을 못 받으므로(403 challenge), 브라우저(클라이언트)가
    //   처리한다. 서버는 요청만 보관하고 lease/progress 응답으로 클라이언트에 전달.

    addExpansion(seriesUrl, series, now) {
        const id = 'x' + (++this.state.expSeq);
        this.state.expansions.push({ id, seriesUrl, series: series || '', ts: now });
        if (this.state.expansions.length > MAX_EXPANSIONS) {
            this.state.expansions = this.state.expansions.slice(-MAX_EXPANSIONS);
        }
        this._persist();
        return { id };
    }

    /** 최근 만료 안 된 expand 요청(클라이언트가 멱등 처리하므로 TTL 내 중복 전달은 무해). */
    getExpansions(now) {
        const before = this.state.expansions.length;
        this.state.expansions = this.state.expansions.filter((e) => now - e.ts < EXPANSION_TTL_MS);
        if (this.state.expansions.length !== before) this._persist();
        return this.state.expansions.map((e) => ({ id: e.id, seriesUrl: e.seriesUrl, series: e.series, ts: e.ts }));
    }

    // ── 구독 자동 업데이트(subscriptions) + 스케줄(cron) ─────────────────────
    //   구독은 seriesUrl을 키로 멱등 upsert한다. /jobs 투입 시 자동 등록되거나
    //   NAS 폴더 가져오기/수동 추가로 등록. 크론 tick이 enabled 구독마다 expand 생성.

    listSubscriptions() {
        return this.state.subscriptions.slice();
    }

    /** seriesUrl 키로 구독 추가/갱신. 기존이 있으면 series/category만 보강(enabled·통계는 보존). */
    upsertSubscription({ seriesUrl, series, category }, now) {
        if (!seriesUrl) return null;
        const key = String(seriesUrl).trim();
        let sub = this.state.subscriptions.find((s) => s.seriesUrl === key);
        if (sub) {
            if (series) sub.series = series;
            if (category) sub.category = category;
        } else {
            sub = {
                seriesUrl: key,
                series: series || '',
                category: category || '',
                addedAt: now,
                lastRun: 0,
                lastNew: 0,
                lastStatus: '',
                enabled: true,
            };
            this.state.subscriptions.push(sub);
        }
        this._persist();
        return sub;
    }

    removeSubscription(seriesUrl) {
        const before = this.state.subscriptions.length;
        this.state.subscriptions = this.state.subscriptions.filter((s) => s.seriesUrl !== seriesUrl);
        const removed = before !== this.state.subscriptions.length;
        if (removed) this._persist();
        return removed;
    }

    setSubscriptionMeta(seriesUrl, patch) {
        const sub = this.state.subscriptions.find((s) => s.seriesUrl === seriesUrl);
        if (!sub) return null;
        if (typeof patch.enabled === 'boolean') sub.enabled = patch.enabled;
        if (typeof patch.lastRun === 'number') sub.lastRun = patch.lastRun;
        if (typeof patch.lastNew === 'number') sub.lastNew = patch.lastNew;
        if (typeof patch.lastStatus === 'string') sub.lastStatus = patch.lastStatus;
        if (typeof patch.series === 'string') sub.series = patch.series;
        if (typeof patch.category === 'string') sub.category = patch.category;
        this._persist();
        return sub;
    }

    getCron() {
        return { ...this.state.cron };
    }

    setCron(patch) {
        if (patch && typeof patch.expr === 'string') this.state.cron.expr = patch.expr.trim();
        if (patch && typeof patch.enabled === 'boolean') this.state.cron.enabled = patch.enabled;
        if (patch && typeof patch.lastRun === 'number') this.state.cron.lastRun = patch.lastRun;
        this._persist();
        return { ...this.state.cron };
    }

    snapshot(now, onlineWindowMs) {
        const ts = this.state.report.ts || 0;
        const online = ts > 0 && now - ts < onlineWindowMs;
        return {
            seq: this.state.seq,
            report: this.state.report,
            captcha: this.state.captcha,
            online,
            serverTime: now,
        };
    }

    // ── 멀티-IP lease 모드 (작업 풀) ─────────────────────────────────────

    /**
     * 작업 enqueue — urls를 unit으로 펼쳐 풀에 추가(정규화 url 키로 멱등).
     * @returns {{added: number, skipped: number}}
     */
    addUnits(series, items, now) {
        let added = 0;
        let skipped = 0;
        for (const raw of items) {
            // raw 는 문자열(url) 또는 객체({url, num, label}) — 후자는 시리즈 목록에서 가져온
            // 권위 회차번호/제목을 동봉(외전·소수회차도 정확히 명명).
            const isObj = raw && typeof raw === 'object';
            const url = String(isObj ? (raw.url || '') : raw).trim();
            if (!url) continue;
            const key = normalizeUrlKey(url);
            if (this._unitKeys.has(key)) {
                skipped++;
                continue;
            }
            const id = `u${++this.state.unitSeq}`;
            this.state.units.push({
                id,
                url,
                key,
                series: series || '',
                label: (isObj && raw.label) ? String(raw.label).slice(0, 200) : urlLabel(url),
                num: (isObj && raw.num != null && raw.num !== '') ? String(raw.num).slice(0, 20) : '',
                cover: (isObj && raw.cover) ? String(raw.cover).slice(0, 500) : '', // 표지 URL(시리즈 공통) — EPUB cover.jpg 용
                meta: (isObj && raw.meta && typeof raw.meta === 'object') ? {     // 시리즈 메타(작가/소개/상태/태그) — 길이 제한
                    author: String(raw.meta.author || '').slice(0, 200),
                    summary: String(raw.meta.summary || '').slice(0, 2000),
                    status: String(raw.meta.status || '').slice(0, 50),
                    tags: Array.isArray(raw.meta.tags) ? raw.meta.tags.slice(0, 30).map((t) => String(t).slice(0, 50)) : [],
                } : null,
                status: 'pending',
                clientId: null,
                leasedAt: 0,
                expiresAt: 0,
                attempts: 0,
                ts: now,
            });
            this._unitKeys.add(key);
            added++;
        }
        this._trimUnits();
        if (added) this._persist();
        return { added, skipped };
    }

    /** 풀 상한 초과 시 오래된 done/failed 종결 unit부터 제거(진행 중 unit은 보존). */
    _trimUnits() {
        if (this.state.units.length <= MAX_UNITS) return;
        const terminal = (s) => s === 'done' || s === 'failed';
        // 종결 unit을 오래된 순(ts 오름차순)으로 제거
        const removable = this.state.units
            .filter((u) => terminal(u.status))
            .sort((a, b) => a.ts - b.ts);
        let need = this.state.units.length - MAX_UNITS;
        const drop = new Set();
        for (const u of removable) {
            if (need <= 0) break;
            drop.add(u.id);
            this._unitKeys.delete(u.key);
            need--;
        }
        if (drop.size) this.state.units = this.state.units.filter((u) => !drop.has(u.id));
    }

    /**
     * 만료된 lease 청소 — `now > expiresAt`인 leased unit을 pending 복귀(attempts++).
     * attempts 상한 도달 시 failed 격리. 호출 시점(lease/complete/clients/heartbeat)마다 lazy 수행.
     * @returns {boolean} 변경 여부
     */
    _expire(now) {
        let changed = false;
        for (const u of this.state.units) {
            if (u.status === 'leased' && u.expiresAt > 0 && now > u.expiresAt) {
                u.attempts++;
                u.clientId = null;
                u.leasedAt = 0;
                u.expiresAt = 0;
                u.status = u.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
                u.ts = now;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * 임대 — pending unit 최대 max개를 원자적으로 clientId에 배정(만료시각 부여).
     * Node 단일스레드 + 동기 처리이므로 핸들러 내 "pending 골라 leased 표시"가 자연히 원자적(락 불필요).
     * @returns {Array} 임대된 unit들의 공개 표현
     */
    setPaused(b) { this.state.paused = !!b; this._persist(); }
    isPaused() { return !!this.state.paused; }

    /** 작업 풀 전체 비우기(pending/leased/done/failed 모두 제거). */
    clearUnits() {
        this.state.units = [];
        this._unitKeys.clear();
        this.state.clearSeq = (this.state.clearSeq || 0) + 1; // 클라가 로컬 큐/워커도 정리하도록 신호 증가
        this._persist();
    }
    getClearSeq() { return this.state.clearSeq || 0; }

    lease(clientId, max, now, ttlMs) {
        // 정지 상태면 새 작업을 내주지 않는다(클라이언트 presence는 progress heartbeat로 유지됨).
        if (this.state.paused) return [];
        const ttl = ttlMs || DEFAULT_LEASE_TTL_MS;
        const limit = Math.max(0, Math.min(Number(max) || 0, 100));
        this._expire(now);
        // 클라이언트 presence 등록 — lease만 하고 아직 /progress를 안 보낸 클라도 대시보드에 즉시 표시.
        // (휘발성 reports에 최소 엔트리 seed; 이후 /progress가 label/ip/progress를 채운다.)
        if (clientId) {
            const r = this.state.reports[clientId];
            if (r) r.ts = now;
            else this.state.reports[clientId] = {
                label: clientId, ip: '', queue: [], running: false, progress: null, current: [], ts: now,
            };
        }
        const out = [];
        for (const u of this.state.units) {
            if (out.length >= limit) break;
            if (u.status === 'pending') {
                u.status = 'leased';
                u.clientId = clientId;
                u.leasedAt = now;
                u.expiresAt = now + ttl;
                u.ts = now;
                out.push(this._publicUnit(u));
            }
        }
        if (out.length) this._persist();
        return out;
    }

    /**
     * 완료 보고 — results[{id, ok}]를 done/failed 처리.
     * 실패(ok=false)→pending 재투입(attempts++), 상한 도달 시 failed 격리.
     * 임대 주체(clientId)만 자신의 leased unit을 종결할 수 있다(내부망 전제, soft 검증).
     * @returns {{done, requeued, failed, ignored}}
     */
    complete(clientId, results, now) {
        const byId = new Map(this.state.units.map((u) => [u.id, u]));
        const summary = { done: 0, requeued: 0, failed: 0, ignored: 0 };
        for (const r of Array.isArray(results) ? results : []) {
            const u = r && byId.get(r.id);
            if (!u || u.status !== 'leased') {
                summary.ignored++;
                continue;
            }
            if (clientId && u.clientId && u.clientId !== clientId) {
                summary.ignored++;
                continue;
            }
            if (r.ok) {
                u.status = 'done';
                u.leasedAt = 0;
                u.expiresAt = 0;
                u.ts = now;
                summary.done++;
            } else {
                u.attempts++;
                u.clientId = null;
                u.leasedAt = 0;
                u.expiresAt = 0;
                u.ts = now;
                if (u.attempts >= MAX_ATTEMPTS) {
                    u.status = 'failed';
                    summary.failed++;
                } else {
                    u.status = 'pending';
                    summary.requeued++;
                }
            }
        }
        if (summary.done || summary.requeued || summary.failed) this._persist();
        return summary;
    }

    _logDedupeKey(clientSeq, time, type, msg) {
        return `${clientSeq}\n${time}\n${type}\n${msg}`;
    }

    _appendLogEntries(prev, inputLogs) {
        const logs = (prev && Array.isArray(prev.logs)) ? prev.logs.slice() : [];
        let logSeq = Number(prev && prev.logSeq) || (logs.length ? Number(logs[logs.length - 1].seq) || 0 : 0);
        const seen = new Set(logs.slice(-MAX_CLIENT_LOGS).map((l) =>
            this._logDedupeKey(l.clientSeq ?? l.seq ?? 0, l.time || '', l.type || 'normal', l.msg || '')
        ));
        const appended = [];
        for (const l of Array.isArray(inputLogs) ? inputLogs : []) {
            if (!l || typeof l.msg !== 'string') continue;
            const msg = l.msg.slice(0, 500);
            if (!msg) continue;
            const clientSeqRaw = Number(l.seq);
            const clientSeq = Number.isFinite(clientSeqRaw) ? clientSeqRaw : 0;
            const time = String(l.time || '');
            const type = String(l.type || 'normal');
            const key = this._logDedupeKey(clientSeq, time, type, msg);
            if (seen.has(key)) continue;
            seen.add(key);
            const entry = {
                seq: ++logSeq,       // 서버 측 단조 증가 seq: 클라 새로고침으로 client seq가 리셋돼도 증분 조회 유지
                clientSeq,
                time,
                type,
                msg,
            };
            logs.push(entry);
            appended.push(entry);
        }
        while (logs.length > MAX_CLIENT_LOGS) logs.shift();
        return { logs, logSeq, appended };
    }

    /**
     * WebSocket 로그 증분 append(휘발성).
     * 진행률 heartbeat와 별개로 들어오므로 기존 queue/running/progress 필드는 보존한다.
     */
    appendClientLogs(clientId, inputLogs, now, meta = {}) {
        const prev = this.state.reports[clientId] || {};
        const { logs, logSeq, appended } = this._appendLogEntries(prev, inputLogs);
        this.state.reports[clientId] = {
            label: meta.label || prev.label || clientId,
            ip: meta.ip || prev.ip || '',
            queue: Array.isArray(prev.queue) ? prev.queue : [],
            running: !!prev.running,
            progress: prev.progress ?? null,
            current: Array.isArray(prev.current) ? prev.current : [],
            logs,
            logSeq,
            version: typeof meta.version === 'string' ? meta.version.slice(0, 60) : (prev.version || ''),
            ts: now,
        };
        return { logs: appended, lastSeq: logSeq };
    }

    /**
     * 클라이언트별 진행/생존 리포트(휘발성) + 보유 lease 갱신(heartbeat).
     * lease 갱신은 expiresAt만 미루는 것이므로 디스크에 쓰지 않는다(재시작 시 만료→재투입은 안전한 실패).
     */
    setClientReport(clientId, report, now, ttlMs) {
        this._expire(now);
        const prev = this.state.reports[clientId];
        const hasCurrent = Array.isArray(report.current);
        const currentLeaseIds = hasCurrent ? new Set(report.current.map((id) => String(id))) : null;
        const logResult = this._appendLogEntries(prev, report.logs);
        this.state.reports[clientId] = {
            label: report.label || clientId,
            ip: report.ip || '',
            queue: Array.isArray(report.queue) ? report.queue : [],
            running: !!report.running,
            progress: report.progress ?? null,
            current: Array.isArray(report.current) ? report.current : [],
            logs: logResult.logs,
            logSeq: logResult.logSeq,
            version: typeof report.version === 'string' ? report.version.slice(0, 60) : '',
            ts: now,
        };
        const ttl = ttlMs || DEFAULT_LEASE_TTL_MS;
        for (const u of this.state.units) {
            if (u.status !== 'leased' || u.clientId !== clientId) continue;
            if (hasCurrent && !currentLeaseIds.has(u.id)) continue;
            u.expiresAt = now + ttl;
        }
        return { logs: logResult.appended, lastSeq: logResult.logSeq };
    }

    clientLeaseIds(clientId, now) {
        this._expire(now);
        return this.state.units
            .filter((u) => u.status === 'leased' && u.clientId === clientId)
            .map((u) => u.id);
    }

    /** 클라이언트별 로그 증분 조회(대시보드 실시간 로그 패널). since 보다 큰 seq 만 반환 + 최신 seq. */
    getClientLogs(clientId, since) {
        const r = this.state.reports[clientId];
        const all = (r && Array.isArray(r.logs)) ? r.logs : [];
        const s = Number.isFinite(since) ? since : 0;
        const logs = all.filter((l) => l.seq > s);
        const lastSeq = all.length ? all[all.length - 1].seq : 0;
        return { logs, lastSeq };
    }

    /**
     * 캡차/차단 격리 — 해당 클라이언트가 보유한 lease를 즉시 pending 재투입.
     * 단위 실패가 아니라 클라이언트 차단이므로 attempts는 올리지 않는다.
     * @returns {number} 재투입된 unit 수
     */
    requeueClient(clientId, now) {
        let n = 0;
        for (const u of this.state.units) {
            if (u.status === 'leased' && u.clientId === clientId) {
                u.status = 'pending';
                u.clientId = null;
                u.leasedAt = 0;
                u.expiresAt = 0;
                u.ts = now;
                n++;
            }
        }
        if (n) this._persist();
        return n;
    }

    /** 특정 unit들을 강제 pending 재투입(대시보드 운영 버튼용 stuck lease 회수). */
    requeueUnits(ids, now, options = {}) {
        const set = new Set(ids || []);
        const allowed = new Set(['leased', 'failed']);
        if (options.allowDone) allowed.add('done');
        if (options.allowPending) allowed.add('pending');
        const resetAttempts = !!options.resetAttempts;
        let n = 0;
        for (const u of this.state.units) {
            if (set.has(u.id) && allowed.has(u.status)) {
                u.status = 'pending';
                u.clientId = null;
                u.leasedAt = 0;
                u.expiresAt = 0;
                if (resetAttempts) u.attempts = 0;
                u.ts = now;
                n++;
            }
        }
        if (n) this._persist();
        return n;
    }

    /** 대시보드용: 풀 요약 + 클라이언트별 online/label/ip/current/진행률. */
    clients(now, onlineWindowMs) {
        this._expire(now);
        const pool = { pending: 0, leased: 0, done: 0, failed: 0, total: this.state.units.length };
        // done unit은 완료 보고 시 clientId를 비우지 않으므로(실패만 비움) 클라별 완료 수를 집계할 수 있다.
        // 풀 비우기/재투입 시 units가 갱신되면 자연히 리셋된다(별도 영속 카운터 불필요).
        const doneByClient = {};
        for (const u of this.state.units) {
            if (pool[u.status] !== undefined) pool[u.status]++;
            if (u.status === 'done' && u.clientId) doneByClient[u.clientId] = (doneByClient[u.clientId] || 0) + 1;
        }
        const clients = Object.entries(this.state.reports).map(([id, r]) => {
            const leasedUnits = this.state.units.filter((u) => u.status === 'leased' && u.clientId === id);
            const leasedIds = new Set(leasedUnits.map((u) => u.id));
            const current = Array.isArray(r.current) ? r.current.filter((unitId) => leasedIds.has(unitId)) : [];
            const leasedById = new Map(leasedUnits.map((u) => [u.id, u]));
            const queueByUnitId = new Map(
                (Array.isArray(r.queue) ? r.queue : [])
                    .filter((q) => q && q.unitId)
                    .map((q) => [String(q.unitId), q])
            );
            const currentItems = current.map((unitId) => {
                const unit = leasedById.get(unitId) || {};
                const q = queueByUnitId.get(unitId) || {};
                const startedAt = Number(q.startedAt || 0);
                const lastProgressAt = Number(q.lastProgressAt || startedAt || 0);
                const retryCount = Number(q.retryCount || 0);
                return {
                    unitId,
                    status: String(q.status || ''),
                    stage: String(q.stage || ''),
                    progressPercent: Number.isFinite(Number(q.progressPercent)) ? Number(q.progressPercent) : 0,
                    startedAt,
                    lastProgressAt,
                    stalledForMs: q.status === 'processing' && lastProgressAt ? Math.max(0, now - lastProgressAt) : 0,
                    retryCount: Number.isFinite(retryCount) ? retryCount : 0,
                    errorMsg: String(q.errorMsg || ''),
                    episodeNum: String(q.episodeNum || unit.num || ''),
                    episodeTitle: String(q.episodeTitle || unit.label || ''),
                    label: unit.label || '',
                    num: unit.num || '',
                    url: unit.url || ''
                };
            });
            return {
                clientId: id,
                label: r.label,
                ip: r.ip,
                online: r.ts > 0 && now - r.ts < onlineWindowMs,
                running: !!r.running && current.length > 0,
                progress: r.progress,
                current,
                currentItems,
                leased: leasedUnits.length,
                done: doneByClient[id] || 0,
                version: r.version || '',
                ts: r.ts,
            };
        });
        return { pool, clients, serverTime: now };
    }

    /** unit 목록(대시보드 상세용, status 필터 옵션). */
    listUnits(now, status) {
        this._expire(now);
        const src = status
            ? this.state.units.filter((u) => u.status === status)
            : this.state.units;
        return src.map((u) => this._publicUnit(u));
    }

    _publicUnit(u) {
        return {
            id: u.id,
            url: u.url,
            series: u.series,
            label: u.label,
            num: u.num || '',
            cover: u.cover || '',
            meta: u.meta || null,
            status: u.status,
            clientId: u.clientId,
            expiresAt: u.expiresAt,
            attempts: u.attempts,
            ts: u.ts,
        };
    }
}
