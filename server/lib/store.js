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
const MAX_EXPANSIONS = 20;               // 보관할 최근 expand 요청 수
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
            paused: false, // true면 /lease가 빈 배열 반환(새 작업 중단), 클라는 stopQueue
            commands: [],
            units: [],
            expansions: [], // 작품 메인 URL → 회차 자동 펼침 요청(클라이언트가 처리)
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
                    paused: !!raw.paused,
                    commands: Array.isArray(raw.commands) ? raw.commands : [],
                    units: Array.isArray(raw.units) ? raw.units : [],
                    expansions: Array.isArray(raw.expansions) ? raw.expansions : [],
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
            const { seq, unitSeq, expSeq, paused, commands, units, expansions, captcha } = this.state;
            writeFileSync(
                this.dataFile,
                JSON.stringify({ seq, unitSeq, expSeq, paused, commands, units, expansions, captcha }, null, 2)
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
    addUnits(series, urls, now) {
        let added = 0;
        let skipped = 0;
        for (const raw of urls) {
            const url = String(raw).trim();
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
                label: urlLabel(url),
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
        this._persist();
    }

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

    /**
     * 클라이언트별 진행/생존 리포트(휘발성) + 보유 lease 갱신(heartbeat).
     * lease 갱신은 expiresAt만 미루는 것이므로 디스크에 쓰지 않는다(재시작 시 만료→재투입은 안전한 실패).
     */
    setClientReport(clientId, report, now, ttlMs) {
        this._expire(now);
        this.state.reports[clientId] = {
            label: report.label || clientId,
            ip: report.ip || '',
            queue: Array.isArray(report.queue) ? report.queue : [],
            running: !!report.running,
            progress: report.progress ?? null,
            current: Array.isArray(report.current) ? report.current : [],
            ts: now,
        };
        const ttl = ttlMs || DEFAULT_LEASE_TTL_MS;
        for (const u of this.state.units) {
            if (u.status === 'leased' && u.clientId === clientId) u.expiresAt = now + ttl;
        }
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
    requeueUnits(ids, now) {
        const set = new Set(ids || []);
        let n = 0;
        for (const u of this.state.units) {
            if (set.has(u.id) && (u.status === 'leased' || u.status === 'failed')) {
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

    /** 대시보드용: 풀 요약 + 클라이언트별 online/label/ip/current/진행률. */
    clients(now, onlineWindowMs) {
        this._expire(now);
        const pool = { pending: 0, leased: 0, done: 0, failed: 0, total: this.state.units.length };
        for (const u of this.state.units) {
            if (pool[u.status] !== undefined) pool[u.status]++;
        }
        const clients = Object.entries(this.state.reports).map(([id, r]) => ({
            clientId: id,
            label: r.label,
            ip: r.ip,
            online: r.ts > 0 && now - r.ts < onlineWindowMs,
            running: r.running,
            progress: r.progress,
            current: r.current,
            leased: this.state.units.filter((u) => u.status === 'leased' && u.clientId === id).length,
            ts: r.ts,
        }));
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
            status: u.status,
            clientId: u.clientId,
            expiresAt: u.expiresAt,
            attempts: u.attempts,
            ts: u.ts,
        };
    }
}
