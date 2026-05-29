#!/usr/bin/env node
/**
 * tokiSync 원격 제어 컨트롤 API 서버 (zero-dependency, 순수 Node http)
 *
 * 역할:
 *  - 대시보드(폰/노트북)가 명령을 기록(POST /queue, /queue/start, /queue/stop, ...).
 *  - 윈도우의 tokiSync 유저스크립트가 GET /queue?since=<seq>를 폴링해 명령 수신·적용.
 *  - 유저스크립트가 POST /progress로 큐/진행률 미러 보고.
 *  - 유저스크립트가 POST /captcha로 캡차 감지 보고 → 텔레그램 발송.
 *  - 대시보드 정적 파일(public/) 서빙.
 *
 * 실행: node control-api.js   (설정: server/config.json 또는 환경변수)
 */
import http from 'node:http';
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './lib/store.js';
import { Telegram } from './lib/telegram.js';
import { sendJson, readJsonBody, normalizeUrls } from './lib/util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

function loadConfig() {
    const file = join(__dirname, 'config.json');
    let cfg = {};
    if (existsSync(file)) {
        try {
            cfg = JSON.parse(readFileSync(file, 'utf8'));
        } catch (e) {
            console.error('[config] parse failed, using defaults:', e.message);
        }
    }
    return {
        port: Number(process.env.PORT || cfg.port || 8787),
        host: process.env.HOST || cfg.host || '0.0.0.0',
        token: process.env.TOKI_API_TOKEN ?? cfg.token ?? '',
        onlineWindowMs: Number(cfg.onlineWindowMs || 30000),
        dataFile: cfg.dataFile
            ? join(__dirname, cfg.dataFile)
            : join(__dirname, 'data', 'state.json'),
        telegram: cfg.telegram || {},
    };
}

const config = loadConfig();
const store = new Store(config.dataFile);
const telegram = new Telegram(config.telegram);
const now = () => Date.now();

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

function authed(req) {
    if (!config.token) return true; // 토큰 미설정 = 오픈 모드(개발용, 기동 시 콘솔 경고)
    const h = req.headers;
    const bearer = (h['authorization'] || '').replace(/^Bearer\s+/i, '');
    // 토큰은 헤더로만 받는다(URL 쿼리는 서버/프록시 로그·Referer에 노출되므로 미지원).
    const tok = h['x-toki-token'] || bearer || '';
    return safeEqual(tok, config.token);
}

/** POST 본문 파싱 — 실패 시 400 응답 후 null 반환 */
async function parseBody(req, res) {
    try {
        return await readJsonBody(req);
    } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message || 'invalid JSON body' });
        return null;
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const full = normalize(join(PUBLIC_DIR, rel));
    // 경계 검사: PUBLIC_DIR 내부 파일만 (구분자 포함 비교로 'public-xxx' 형제 디렉터리 우회 차단)
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
    }
    res.writeHead(200, {
        'Content-Type': MIME[extname(full)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
    });
    createReadStream(full).pipe(res);
}

async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    // 헬스체크는 인증 불필요
    if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
            ok: true,
            time: now(),
            telegram: telegram.enabled(),
            auth: !!config.token,
        });
    }

    if (!authed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    // GET /queue — 대시보드/유저스크립트 공용 (since로 명령 증분 조회)
    if (method === 'GET' && pathname === '/queue') {
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw === null ? -1 : Number(sinceRaw);
        const snap = store.snapshot(now(), config.onlineWindowMs);
        return sendJson(res, 200, {
            ...snap,
            commands: store.commandsSince(Number.isFinite(since) ? since : -1),
        });
    }

    if (method === 'POST' && pathname === '/queue') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const urls = normalizeUrls(body.urls);
        if (!urls.length) return sendJson(res, 400, { ok: false, error: 'no valid urls' });
        const seq = store.addCommand('add', { urls }, now());
        return sendJson(res, 200, { ok: true, seq, count: urls.length });
    }

    if (method === 'POST' && pathname === '/queue/start') {
        const seq = store.addCommand('start', null, now());
        return sendJson(res, 200, { ok: true, seq });
    }

    if (method === 'POST' && pathname === '/queue/stop') {
        const seq = store.addCommand('stop', null, now());
        return sendJson(res, 200, { ok: true, seq });
    }

    if (method === 'POST' && pathname === '/queue/clear') {
        const seq = store.addCommand('clear', null, now());
        return sendJson(res, 200, { ok: true, seq });
    }

    if (method === 'POST' && pathname === '/queue/remove') {
        const body = await parseBody(req, res);
        if (body === null) return;
        if (!body.url) return sendJson(res, 400, { ok: false, error: 'no url' });
        const seq = store.addCommand('remove', { url: String(body.url) }, now());
        return sendJson(res, 200, { ok: true, seq });
    }

    if (method === 'POST' && pathname === '/progress') {
        const body = await parseBody(req, res);
        if (body === null) return;
        store.setReport(body, now());
        return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/captcha') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const msg =
            (typeof body.message === 'string' && body.message.trim()
                ? body.message.slice(0, 1000)
                : '') || '⚠️ tokiSync 캡차 감지 — 원격에서 브라우저 확인 필요';
        const capUrl = typeof body.url === 'string' ? body.url.slice(0, 500) : '';
        store.addCaptcha(msg, capUrl, now());
        const text = `${msg}${capUrl ? '\n' + capUrl : ''}`;
        const tg = await telegram.notify(text, now());
        return sendJson(res, 200, { ok: true, telegram: tg });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const { pathname } = url;
        const method = req.method;

        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Toki-Token',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Max-Age': '86400',
            });
            res.end();
            return;
        }

        const isApi =
            pathname === '/queue' ||
            pathname.startsWith('/queue/') ||
            pathname === '/progress' ||
            pathname === '/captcha' ||
            pathname.startsWith('/api');

        if (isApi) return await handleApi(req, res, url);

        if (method === 'GET') return serveStatic(req, res, pathname);

        res.writeHead(405);
        res.end('method not allowed');
    } catch (e) {
        console.error('[server] error:', e.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
        else res.end();
    }
});

server.listen(config.port, config.host, () => {
    console.log(`[tokiSync-control] listening on http://${config.host}:${config.port}`);
    console.log(`[tokiSync-control] dashboard:  http://<this-host>:${config.port}/`);
    console.log(
        `[tokiSync-control] auth:      ${config.token ? 'token required ✅' : 'OPEN ⚠️ (set token for security)'}`
    );
    console.log(
        `[tokiSync-control] telegram:  ${telegram.enabled() ? 'configured ✅' : 'NOT configured ⚠️'}`
    );
    console.log(`[tokiSync-control] data:      ${config.dataFile}`);
});

// graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`\n[tokiSync-control] ${sig} received, shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
