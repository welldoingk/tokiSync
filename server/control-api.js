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
import { createHash, timingSafeEqual } from 'node:crypto';
import { Store } from './lib/store.js';
import { Telegram } from './lib/telegram.js';
import { sendJson, readJsonBody, normalizeUrls } from './lib/util.js';
import { listNasCategories, listNasSeries, scanNasSeries, normalizeEpisodeNumber, putNasFile } from './lib/nas-webdav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const DOCS_DIR = join(__dirname, '..', 'docs');

// 빌드된 유저스크립트(docs/tokiSync.user.js)의 @version 을 읽어 대시보드 "최신 버전" 기준으로 제공.
//   → 대시보드 LATEST 하드코딩 불필요(빌드만 하면 자동 동기화). mtime 캐시로 변경 시에만 재파싱.
const DOCS_USERSCRIPT = join(__dirname, '..', 'docs', 'tokiSync.user.js');
let _verCache = { v: '', mtime: 0 };
function readLatestClientVersion() {
    try {
        const st = statSync(DOCS_USERSCRIPT);
        if (_verCache.v && st.mtimeMs === _verCache.mtime) return _verCache.v;
        const txt = readFileSync(DOCS_USERSCRIPT, 'utf8');
        const m = txt.match(/@version\s+(\S+)/);
        _verCache = { v: m ? m[1] : '', mtime: st.mtimeMs };
        return _verCache.v;
    } catch (e) { return ''; }
}

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
        leaseTtlMs: Number(cfg.leaseTtlMs || 120000), // lease 기본 TTL(2분) — 만료 시 자동 재투입
        leaseMax: Number(cfg.leaseMax || 4),          // /lease max 미지정 시 기본 배정 수
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

// 청크 NAS 업로드 세션 버퍼(브라우저 GM_xhr 대용량 본문 한계 우회용 릴레이).
//   uploadId → { meta, parts[], received, total, ts }. 5분 무활동 시 자동 폐기.
const nasUploads = new Map();
setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, up] of nasUploads) if (up.ts < cutoff) nasUploads.delete(id);
}, 60 * 1000).unref?.();

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

function tokenAuthed(token) {
    if (!config.token) return true;
    return safeEqual(token || '', config.token);
}

/**
 * clientId 정규화 — 신뢰 라벨(내부망 전제)이지만 키/로그 안전을 위해 화이트리스트 검증.
 * 영문/숫자/._- 만 허용, 최대 64자. 부적합/빈값이면 '' 반환(레거시 단일모드로 폴백).
 */
function sanitizeClientId(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) return '';
    return s;
}

function nasOptions(body) {
    return {
        webdavUrl: String(body.webdavUrl || '').trim().slice(0, 500),
        user: String(body.user || '').trim().slice(0, 200),
        pass: String(body.pass || ''),
        category: String(body.category || 'Webtoon').trim().slice(0, 80) || 'Webtoon',
        series: String(body.series || '').trim().slice(0, 240),
        minSizeRatio: Number.isFinite(Number(body.minSizeRatio)) ? Number(body.minSizeRatio) : 0.5,
    };
}

function buildNasAudit(scan, units) {
    const bestFileByNum = new Map();
    for (const f of scan.files || []) {
        const prev = bestFileByNum.get(f.numKey);
        if (!prev || (f.valid && !prev.valid) || Number(f.size || 0) > Number(prev.size || 0)) {
            bestFileByNum.set(f.numKey, f);
        }
    }

    const sameSeries = units.filter((u) => !scan.series || u.series === scan.series);
    const rows = sameSeries.map((u) => {
        const numKey = normalizeEpisodeNumber(u.num || '');
        const file = bestFileByNum.get(numKey);
        const nasStatus = file ? (file.valid ? 'valid' : 'small') : 'missing';
        const retryable = nasStatus !== 'valid' && (u.status === 'done' || u.status === 'failed');
        return {
            id: u.id,
            url: u.url,
            series: u.series,
            label: u.label,
            num: u.num || '',
            status: u.status,
            attempts: u.attempts || 0,
            nasStatus,
            fileName: file ? file.name : '',
            fileSize: file ? file.size : 0,
            retryable,
        };
    }).sort((a, b) => {
        const an = Number(normalizeEpisodeNumber(a.num)) || 0;
        const bn = Number(normalizeEpisodeNumber(b.num)) || 0;
        return bn - an;
    });

    const summary = {
        files: (scan.files || []).length,
        validFiles: (scan.files || []).filter((f) => f.valid).length,
        smallFiles: (scan.files || []).filter((f) => !f.valid).length,
        units: rows.length,
        done: rows.filter((r) => r.status === 'done').length,
        failed: rows.filter((r) => r.status === 'failed').length,
        pending: rows.filter((r) => r.status === 'pending').length,
        leased: rows.filter((r) => r.status === 'leased').length,
        stored: rows.filter((r) => r.nasStatus === 'valid').length,
        missing: rows.filter((r) => r.nasStatus === 'missing').length,
        small: rows.filter((r) => r.nasStatus === 'small').length,
        retryable: rows.filter((r) => r.retryable).length,
    };
    return {
        folderUrl: scan.folderUrl,
        category: scan.category,
        series: scan.series,
        thresholdBytes: scan.thresholdBytes,
        summary,
        rows,
        suggestedIds: rows.filter((r) => r.retryable).map((r) => r.id),
    };
}

function sendNasError(res, e) {
    const msg = e && e.message ? e.message : 'NAS WebDAV error';
    const status = /required|valid|folder/i.test(msg) ? 400 : 502;
    return sendJson(res, status, { ok: false, error: msg });
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

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_PAYLOAD = 1024 * 1024;
const wsPeers = new Set();

function wsFrame(payload, opcode = 1) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    let head;
    if (data.length < 126) {
        head = Buffer.alloc(2);
        head[1] = data.length;
    } else if (data.length < 65536) {
        head = Buffer.alloc(4);
        head[1] = 126;
        head.writeUInt16BE(data.length, 2);
    } else {
        head = Buffer.alloc(10);
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(data.length), 2);
    }
    head[0] = 0x80 | opcode;
    return Buffer.concat([head, data]);
}

function wsSend(peer, msg) {
    if (!peer || !peer.socket || peer.socket.destroyed) return false;
    try {
        peer.socket.write(wsFrame(JSON.stringify(msg), 1));
        return true;
    } catch (e) {
        return false;
    }
}

function wsClose(peer, code = 1000, reason = '') {
    if (!peer || !peer.socket || peer.socket.destroyed) return;
    try {
        const text = String(reason || '').slice(0, 120);
        const payload = Buffer.alloc(2 + Buffer.byteLength(text));
        payload.writeUInt16BE(code, 0);
        payload.write(text, 2);
        peer.socket.write(wsFrame(payload, 8));
    } catch (e) {}
    try { peer.socket.end(); } catch (e) {}
}

function wsRemove(peer) {
    wsPeers.delete(peer);
}

function broadcastClientLogs(clientId, logs, lastSeq) {
    if (!logs || !logs.length) return;
    for (const peer of wsPeers) {
        if (!peer.authed || peer.role !== 'dashboard') continue;
        if (peer.subClientId !== clientId) continue;
        wsSend(peer, { type: 'logs', clientId, logs, lastSeq });
    }
}

function clientsSnapshotPayload() {
    const t = now();
    return {
        type: 'clients',
        ok: true,
        paused: store.isPaused(),
        latestClientVersion: readLatestClientVersion(),
        leasedUnits: store.listUnits(t, 'leased'),
        ...store.clients(t, config.onlineWindowMs),
    };
}

function broadcastClientsSnapshot() {
    const payload = clientsSnapshotPayload();
    for (const peer of wsPeers) {
        if (!peer.authed || peer.role !== 'dashboard') continue;
        wsSend(peer, payload);
    }
}

function handleWsMessage(peer, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return wsClose(peer, 1003, 'invalid json'); }
    if (!msg || typeof msg !== 'object') return;

    if (!peer.authed) {
        if (msg.type !== 'hello' || !tokenAuthed(msg.token)) {
            return wsClose(peer, 1008, 'unauthorized');
        }
        const role = msg.role === 'dashboard' ? 'dashboard' : 'client';
        peer.authed = true;
        peer.role = role;
        if (role === 'client') {
            const clientId = sanitizeClientId(msg.clientId);
            if (!clientId) return wsClose(peer, 1008, 'clientId required');
            peer.clientId = clientId;
            store.appendClientLogs(clientId, [], now(), {
                label: typeof msg.label === 'string' ? msg.label.slice(0, 80) : clientId,
                ip: typeof msg.ip === 'string' ? msg.ip.slice(0, 80) : '',
                version: typeof msg.version === 'string' ? msg.version : '',
            });
        }
        wsSend(peer, { type: 'hello', ok: true, role, serverTime: now() });
        return;
    }

    if (peer.role === 'dashboard') {
        if (msg.type === 'subscribeLogs') {
            const clientId = sanitizeClientId(msg.clientId);
            peer.subClientId = clientId;
            if (!clientId) return wsSend(peer, { type: 'logs', clientId: '', logs: [], lastSeq: 0 });
            const sinceRaw = Number(msg.since);
            const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
            return wsSend(peer, { type: 'logs', clientId, ...store.getClientLogs(clientId, since) });
        }
        return;
    }

    if (peer.role === 'client' && msg.type === 'clientLogs') {
        const clientId = sanitizeClientId(msg.clientId) || peer.clientId;
        if (clientId !== peer.clientId) return wsClose(peer, 1008, 'clientId mismatch');
        const result = store.appendClientLogs(clientId, msg.logs, now(), {
            label: typeof msg.label === 'string' ? msg.label.slice(0, 80) : clientId,
            ip: typeof msg.ip === 'string' ? msg.ip.slice(0, 80) : '',
            version: typeof msg.version === 'string' ? msg.version : '',
        });
        broadcastClientLogs(clientId, result.logs, result.lastSeq);
    }

    if (peer.role === 'client' && msg.type === 'clientReport') {
        const clientId = sanitizeClientId(msg.clientId) || peer.clientId;
        if (clientId !== peer.clientId) return wsClose(peer, 1008, 'clientId mismatch');
        const body = (msg.report && typeof msg.report === 'object') ? msg.report : {};
        const result = store.setClientReport(clientId, { ...body, clientId, logs: [] }, now(), config.leaseTtlMs);
        broadcastClientLogs(clientId, result.logs, result.lastSeq);
        broadcastClientsSnapshot();
    }
}

function parseWsFrames(peer) {
    while (peer.buffer.length >= 2) {
        const b0 = peer.buffer[0];
        const b1 = peer.buffer[1];
        const opcode = b0 & 0x0f;
        const masked = !!(b1 & 0x80);
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (peer.buffer.length < offset + 2) return;
            len = peer.buffer.readUInt16BE(offset);
            offset += 2;
        } else if (len === 127) {
            if (peer.buffer.length < offset + 8) return;
            const bigLen = peer.buffer.readBigUInt64BE(offset);
            if (bigLen > BigInt(WS_MAX_PAYLOAD)) return wsClose(peer, 1009, 'payload too large');
            len = Number(bigLen);
            offset += 8;
        }
        if (len > WS_MAX_PAYLOAD) return wsClose(peer, 1009, 'payload too large');
        if (!masked) return wsClose(peer, 1002, 'masked client frame required');
        if (peer.buffer.length < offset + 4 + len) return;
        const mask = peer.buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(peer.buffer.subarray(offset, offset + len));
        peer.buffer = peer.buffer.subarray(offset + len);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

        if (opcode === 0x8) {
            wsClose(peer);
            return;
        }
        if (opcode === 0x9) {
            try { peer.socket.write(wsFrame(payload, 0xA)); } catch (e) {}
            continue;
        }
        if (opcode === 0xA) {
            peer.lastPong = now();
            continue;
        }
        if (opcode !== 0x1) continue;
        handleWsMessage(peer, payload.toString('utf8'));
    }
}

function handleWsUpgrade(req, socket, head) {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (req.method !== 'GET' || url.pathname !== '/ws') {
            socket.destroy();
            return;
        }
        const key = req.headers['sec-websocket-key'];
        if (!key) {
            socket.destroy();
            return;
        }
        const accept = createHash('sha1').update(String(key) + WS_GUID).digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            '\r\n'
        );
        const peer = {
            socket,
            buffer: Buffer.alloc(0),
            authed: false,
            role: '',
            clientId: '',
            subClientId: '',
            lastPong: now(),
        };
        wsPeers.add(peer);
        socket.on('data', (chunk) => {
            peer.buffer = Buffer.concat([peer.buffer, chunk]);
            parseWsFrames(peer);
        });
        socket.on('close', () => wsRemove(peer));
        socket.on('error', () => wsRemove(peer));
        if (head && head.length) {
            peer.buffer = Buffer.concat([peer.buffer, head]);
            parseWsFrames(peer);
        }
    } catch (e) {
        try { socket.destroy(); } catch (_) {}
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
        'Cache-Control': 'no-store',
    });
    createReadStream(full).pipe(res);
}

function serveDocsFile(res, filename) {
    const full = normalize(join(DOCS_DIR, filename));
    if (full !== DOCS_DIR && !full.startsWith(DOCS_DIR + sep)) {
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
        // clientId가 있으면 멀티-IP lease 모드(클라별 리포트 + lease 갱신/heartbeat),
        // 없으면 레거시 단일 슬롯 모드(하위호환).
        const clientId = sanitizeClientId(body.clientId);
        if (clientId) {
            const logResult = store.setClientReport(clientId, body, now(), config.leaseTtlMs);
            broadcastClientLogs(clientId, logResult.logs, logResult.lastSeq);
            broadcastClientsSnapshot();
            const ownedLeaseIds = store.clientLeaseIds(clientId, now());
            // heartbeat 응답: pending expand 요청 + 정지(paused) + clearSeq(풀 비우기 신호) → 클라가 stopQueue/로컬 큐 정리.
            return sendJson(res, 200, { ok: true, expansions: store.getExpansions(now()), paused: store.isPaused(), clearSeq: store.getClearSeq(), ownedLeaseIds });
        }
        store.setReport(body, now());
        return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/captcha') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const clientId = sanitizeClientId(body.clientId);
        // 캡차/차단 격리: 해당 클라가 보유한 lease를 즉시 재투입(다른 클라는 계속).
        const requeued = clientId ? store.requeueClient(clientId, now()) : 0;
        const who = clientId ? `[${clientId}] ` : '';
        const msg =
            (typeof body.message === 'string' && body.message.trim()
                ? body.message.slice(0, 1000)
                : '') || '⚠️ tokiSync 캡차 감지 — 원격에서 브라우저 확인 필요';
        const capUrl = typeof body.url === 'string' ? body.url.slice(0, 500) : '';
        store.addCaptcha(who + msg, capUrl, now());
        if (requeued) broadcastClientsSnapshot();
        const requeueNote = requeued ? `\n↩️ lease ${requeued}건 재투입` : '';
        const text = `${who}${msg}${capUrl ? '\n' + capUrl : ''}${requeueNote}`;
        const tg = await telegram.notify(text, now());
        return sendJson(res, 200, { ok: true, telegram: tg, requeued });
    }

    // ── 멀티-IP lease 모드 엔드포인트 ────────────────────────────────────

    // POST /jobs {series, urls[]|units[]} — 작업 enqueue(회차 unit으로 펼침, 멱등)
    if (method === 'POST' && pathname === '/jobs') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const series = typeof body.series === 'string' ? body.series.slice(0, 200) : '';
        // units[]({url,num,label}) 우선(시리즈 목록의 권위 번호/제목 동봉), 없으면 urls[](문자열).
        let items;
        if (Array.isArray(body.units) && body.units.length) {
            items = body.units.filter((u) => u && typeof u.url === 'string' && /^https?:\/\//i.test(u.url));
        } else {
            items = normalizeUrls(body.urls);
        }
        if (!items.length) return sendJson(res, 400, { ok: false, error: 'no valid urls/units' });
        const { added, skipped } = store.addUnits(series, items, now());
        const { pool } = store.clients(now(), config.onlineWindowMs);
        if (added) broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true, added, skipped, pool });
    }

    // POST /jobs/expand {seriesUrl, series} — 작품 메인 URL 자동 펼침 요청.
    //   서버는 Cloudflare로 회차 목록을 못 받으므로, 요청만 보관 → 온라인 클라이언트가
    //   브라우저에서 회차 목록을 추출해 /jobs 로 투입한다.
    if (method === 'POST' && pathname === '/jobs/expand') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const seriesUrl = typeof body.seriesUrl === 'string' ? body.seriesUrl.trim() : '';
        if (!/^https?:\/\//i.test(seriesUrl)) {
            return sendJson(res, 400, { ok: false, error: 'valid seriesUrl required' });
        }
        const series = typeof body.series === 'string' ? body.series.slice(0, 200) : '';
        const { id } = store.addExpansion(seriesUrl.slice(0, 500), series, now());
        return sendJson(res, 200, { ok: true, id });
    }

    // POST /pause — 새 lease 중단(클라는 heartbeat의 paused로 stopQueue). POST /resume — 재개.
    if (method === 'POST' && (pathname === '/pause' || pathname === '/resume')) {
        store.setPaused(pathname === '/pause');
        broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true, paused: store.isPaused() });
    }

    // POST /jobs/clear — 작업 풀 전체 비우기(진행 중 포함 모든 unit 제거).
    if (method === 'POST' && pathname === '/jobs/clear') {
        store.clearUnits();
        broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true });
    }

    // GET /lease?clientId=X&max=N — pending unit 최대 N개를 원자적으로 임대
    if (method === 'GET' && pathname === '/lease') {
        const clientId = sanitizeClientId(url.searchParams.get('clientId'));
        if (!clientId) return sendJson(res, 400, { ok: false, error: 'clientId required' });
        const maxRaw = Number(url.searchParams.get('max'));
        const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : config.leaseMax;
        const units = store.lease(clientId, max, now(), config.leaseTtlMs);
        if (units.length) broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true, clientId, units, leaseTtlMs: config.leaseTtlMs });
    }

    // POST /complete {clientId, results:[{id, ok}]} — unit done/failed 처리
    if (method === 'POST' && pathname === '/complete') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const clientId = sanitizeClientId(body.clientId);
        if (!clientId) return sendJson(res, 400, { ok: false, error: 'clientId required' });
        if (!Array.isArray(body.results)) {
            return sendJson(res, 400, { ok: false, error: 'results[] required' });
        }
        const summary = store.complete(clientId, body.results, now());
        if (summary.done || summary.requeued || summary.failed) broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true, ...summary });
    }

    // GET /clients — 대시보드용: 클라이언트별 상태 + 풀 요약 + 정지 상태
    if (method === 'GET' && pathname === '/clients') {
        return sendJson(res, 200, clientsSnapshotPayload());
    }

    // GET /units?status=pending — unit 목록(대시보드 상세/디버그)
    if (method === 'GET' && pathname === '/units') {
        const status = url.searchParams.get('status') || '';
        return sendJson(res, 200, { ok: true, units: store.listUnits(now(), status) });
    }

    // POST /nas/upload — 워커가 보낸 파일 청크를 모아 조립 후 NAS WebDAV로 직접 PUT.
    //   브라우저 GM_xmlhttpRequest가 대용량 요청-본문을 못 보내는 한계를 우회한다.
    //   body: { uploadId, seq, total, chunkB64, meta?{webdavUrl,user,pass,category,folder,fileName,contentType} }
    if (method === 'POST' && pathname === '/nas/upload') {
        const body = await parseBody(req, res);
        if (body === null) return;
        const id = String(body.uploadId || '').slice(0, 80);
        const seq = Number(body.seq);
        const total = Number(body.total);
        if (!id || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(total) || total < 1) {
            return sendJson(res, 400, { ok: false, error: 'uploadId/seq/total required' });
        }
        let up = nasUploads.get(id);
        if (!up) {
            const m = body.meta || {};
            up = { meta: m, parts: new Array(total), received: 0, total, ts: now() };
            nasUploads.set(id, up);
        }
        up.ts = now();
        if (typeof body.chunkB64 === 'string' && seq < total && up.parts[seq] === undefined) {
            up.parts[seq] = Buffer.from(body.chunkB64, 'base64');
            up.received++;
        }
        if (up.received < up.total) {
            return sendJson(res, 200, { ok: true, received: up.received, total: up.total });
        }
        // 전 청크 수신 완료 → 조립 후 NAS PUT
        nasUploads.delete(id);
        try {
            const buf = Buffer.concat(up.parts.map((p) => p || Buffer.alloc(0)));
            const m = up.meta || {};
            const result = await putNasFile(
                { webdavUrl: m.webdavUrl, user: m.user, pass: m.pass },
                m.category, m.folder, m.fileName, buf, m.contentType
            );
            return sendJson(res, 200, { ok: true, done: true, ...result });
        } catch (e) {
            return sendJson(res, 502, { ok: false, error: e && e.message ? e.message : 'NAS PUT 실패' });
        }
    }

    // POST /nas/categories — NAS WebDAV 루트 아래 카테고리 폴더 목록 조회.
    if (method === 'POST' && pathname === '/nas/categories') {
        const body = await parseBody(req, res);
        if (body === null) return;
        try {
            const result = await listNasCategories(nasOptions(body));
            return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
            return sendNasError(res, e);
        }
    }

    // POST /nas/series — NAS WebDAV category 폴더 아래 저장된 작품 폴더 목록 조회.
    if (method === 'POST' && pathname === '/nas/series') {
        const body = await parseBody(req, res);
        if (body === null) return;
        try {
            const result = await listNasSeries(nasOptions(body));
            return sendJson(res, 200, { ok: true, ...result });
        } catch (e) {
            return sendNasError(res, e);
        }
    }

    // POST /nas/scan — NAS 실제 파일과 서버 unit 상태를 회차 번호 기준으로 비교.
    if (method === 'POST' && pathname === '/nas/scan') {
        const body = await parseBody(req, res);
        if (body === null) return;
        try {
            const opts = nasOptions(body);
            const scan = await scanNasSeries(opts);
            const units = store.listUnits(now(), '');
            return sendJson(res, 200, { ok: true, ...buildNasAudit(scan, units) });
        } catch (e) {
            return sendNasError(res, e);
        }
    }

    // POST /nas/requeue {ids:[]} — NAS 누락/손상으로 판정된 done/failed unit 재다운로드.
    if (method === 'POST' && pathname === '/nas/requeue') {
        const body = await parseBody(req, res);
        if (body === null) return;
        if (!Array.isArray(body.ids)) return sendJson(res, 400, { ok: false, error: 'ids[] required' });
        const requeued = store.requeueUnits(body.ids, now(), { allowDone: true, allowPending: false, resetAttempts: true });
        if (requeued) broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true, requeued });
    }

    // GET /logs?clientId=X&since=N — 클라이언트별 로그 증분(대시보드 실시간 로그 패널)
    if (method === 'GET' && pathname === '/logs') {
        const clientId = sanitizeClientId(url.searchParams.get('clientId'));
        if (!clientId) return sendJson(res, 400, { ok: false, error: 'clientId required' });
        const sinceRaw = Number(url.searchParams.get('since'));
        const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
        return sendJson(res, 200, { ok: true, clientId, ...store.getClientLogs(clientId, since) });
    }

    // POST /requeue {ids:[]} — stuck lease/failed unit 강제 재투입(운영 버튼)
    if (method === 'POST' && pathname === '/requeue') {
        const body = await parseBody(req, res);
        if (body === null) return;
        if (!Array.isArray(body.ids)) return sendJson(res, 400, { ok: false, error: 'ids[] required' });
        const requeued = store.requeueUnits(body.ids, now());
        if (requeued) broadcastClientsSnapshot();
        return sendJson(res, 200, { ok: true, requeued });
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
            pathname === '/jobs' ||
            pathname === '/jobs/expand' ||
            pathname === '/jobs/clear' ||
            pathname === '/pause' ||
            pathname === '/resume' ||
            pathname === '/lease' ||
            pathname === '/complete' ||
            pathname === '/clients' ||
            pathname === '/units' ||
            pathname.startsWith('/nas/') ||
            pathname === '/logs' ||
            pathname === '/requeue' ||
            pathname.startsWith('/api');

        if (isApi) return await handleApi(req, res, url);

        if (method === 'GET' && pathname === '/tokiSync.user.js') {
            return serveDocsFile(res, 'tokiSync.user.js');
        }
        if (method === 'GET' && pathname === '/rules.json') {
            return serveDocsFile(res, 'rules.json');
        }

        if (method === 'GET') return serveStatic(req, res, pathname);

        res.writeHead(405);
        res.end('method not allowed');
    } catch (e) {
        console.error('[server] error:', e.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
        else res.end();
    }
});

server.on('upgrade', handleWsUpgrade);

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
        for (const peer of wsPeers) wsClose(peer, 1001, 'server shutting down');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
