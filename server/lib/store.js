/**
 * 상태 저장소 — 명령 로그(command log) + 유저스크립트 리포트 + 캡차 로그.
 *
 * 모델:
 *  - 대시보드가 명령(add/start/stop/clear/remove)을 append → 각 명령에 단조 증가 seq 부여.
 *  - 유저스크립트가 `GET /queue?since=<seq>` 폴링 → seq보다 큰 명령만 받아 적용.
 *  - 유저스크립트가 `POST /progress`로 로컬 큐/실행상태/진행률을 리포트(미러).
 *  - 캡차 감지는 별도 로그 + 텔레그램 트리거.
 *
 * 디스크 영속화(JSON): 서버 재시작 후에도 상태 유지.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_COMMANDS = 200;
const MAX_CAPTCHA = 50;

export class Store {
    constructor(dataFile) {
        this.dataFile = dataFile || '';
        this.state = {
            seq: 0,
            commands: [],
            report: { queue: [], running: false, progress: null, ts: 0 },
            captcha: [],
        };
        this._load();
    }

    _load() {
        try {
            if (this.dataFile && existsSync(this.dataFile)) {
                const raw = JSON.parse(readFileSync(this.dataFile, 'utf8'));
                this.state = {
                    seq: Number(raw.seq) || 0,
                    commands: Array.isArray(raw.commands) ? raw.commands : [],
                    report: raw.report || this.state.report,
                    captcha: Array.isArray(raw.captcha) ? raw.captcha : [],
                };
            }
        } catch (e) {
            console.error('[store] load failed:', e.message);
        }
    }

    _persist() {
        if (!this.dataFile) return;
        try {
            mkdirSync(dirname(this.dataFile), { recursive: true });
            writeFileSync(this.dataFile, JSON.stringify(this.state, null, 2));
        } catch (e) {
            console.error('[store] persist failed:', e.message);
        }
    }

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
}
