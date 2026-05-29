/**
 * 텔레그램 알림 — 캡차 감지 시 발송.
 *
 * 설정 우선순위:
 *   1) botToken + chatId 직접 지정(env/config) → Telegram Bot API 직접 호출
 *   2) scriptPath 지정 → 기존 telegram-noti.sh 스크립트 실행(봇 토큰을 repo에 두지 않음)
 *   3) 둘 다 없으면 no-op(경고 로그)
 *
 * 비밀값(botToken)은 repo에 커밋하지 말 것 — env(TELEGRAM_BOT_TOKEN) 또는
 * gitignore된 server/config.json으로 주입한다.
 */
import { spawn } from 'node:child_process';
import https from 'node:https';

export class Telegram {
    constructor(cfg = {}) {
        this.botToken = cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
        this.chatId = cfg.chatId || process.env.TELEGRAM_CHAT_ID || '';
        this.threadId = cfg.threadId ?? process.env.TELEGRAM_THREAD_ID ?? '';
        this.scriptPath = cfg.scriptPath || process.env.TELEGRAM_SCRIPT || '';
        this.minIntervalMs = cfg.minIntervalMs ?? 60000; // 캡차 알림 스팸 방지
        this._lastSent = 0;
    }

    enabled() {
        return !!((this.botToken && this.chatId) || this.scriptPath);
    }

    async notify(text, now = Date.now()) {
        if (now - this._lastSent < this.minIntervalMs) {
            return { ok: false, skipped: 'throttled' };
        }
        this._lastSent = now;
        if (this.botToken && this.chatId) return this._viaApi(text);
        if (this.scriptPath) return this._viaScript(text);
        console.warn('[telegram] not configured; message dropped:', text);
        return { ok: false, skipped: 'unconfigured' };
    }

    _viaApi(text) {
        return new Promise((resolve) => {
            const payload = JSON.stringify({
                chat_id: this.chatId,
                ...(this.threadId !== '' ? { message_thread_id: Number(this.threadId) } : {}),
                text,
            });
            const req = https.request(
                {
                    hostname: 'api.telegram.org',
                    path: `/bot${this.botToken}/sendMessage`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                    timeout: 10000,
                },
                (res) => {
                    let body = '';
                    res.on('data', (d) => (body += d));
                    res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
                }
            );
            req.on('error', (e) => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
            req.write(payload);
            req.end();
        });
    }

    _viaScript(text) {
        return new Promise((resolve) => {
            // NUL 제거 + 길이 제한 (요청자 제어 문자열이 인자로 들어가므로 방어)
            const safeText = String(text).replace(/\0/g, '').slice(0, 2000);
            const args = [];
            if (this.threadId !== '') args.push('-t', String(this.threadId));
            // spawn(shell=false) + getopts "...m:" 조합: '-m' 다음 토큰은 무조건 OPTARG로
            // 소비되므로 메시지가 '-'로 시작해도 플래그로 오인되지 않는다(argument injection 불가).
            args.push('-m', safeText);
            let ch;
            try {
                ch = spawn(this.scriptPath, args, { stdio: 'ignore' });
            } catch (e) {
                resolve({ ok: false, error: e.message });
                return;
            }
            ch.on('error', (e) => resolve({ ok: false, error: e.message }));
            ch.on('close', (code) => resolve({ ok: code === 0, code }));
        });
    }
}
