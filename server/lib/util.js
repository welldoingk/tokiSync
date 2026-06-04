/**
 * 공용 HTTP 유틸 — JSON 응답/요청 본문 파싱.
 */

export function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Toki-Token',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

// 한도 16MB: 대형 시리즈의 회차 unit 목록을 한 번에 enqueue할 수 있어야 한다.
//   (예: 3108회차 소설 → {units:[...]} 본문 ≈ 1.3MB. 1MB 한도면 req.destroy()로 소켓이
//    끊겨 클라 GM_xmlhttpRequest가 "network error"로 실패했음 — 큰 작품 투입 불가 버그.)
export function readJsonBody(req, limit = 16_000_000) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/** 문자열/배열 입력을 http(s) URL 배열로 정규화(중복 제거). */
export function normalizeUrls(input) {
    let arr = [];
    if (Array.isArray(input)) arr = input;
    else if (typeof input === 'string') arr = input.split(/[\s\n]+/);
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        const s = String(raw).trim();
        if (!/^https?:\/\//i.test(s)) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/**
 * unit 멱등 키 — trailing slash/대소문자 호스트 차이를 흡수해 같은 회차의 중복 enqueue를 막는다.
 * (도메인 미러는 호스트가 다르면 별개로 본다 — 의도적으로 보수적. 같은 회차 중복 방지의 핵심은 호스트+경로.)
 */
export function normalizeUrlKey(url) {
    const s = String(url).trim();
    try {
        const u = new URL(s);
        const path = u.pathname.replace(/\/+$/, '');
        return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
    } catch {
        return s.replace(/\/+$/, '').toLowerCase();
    }
}

/** unit 표시 라벨 — URL의 마지막 경로 세그먼트(없으면 호스트, 그래도 없으면 원본). */
export function urlLabel(url) {
    const s = String(url).trim();
    try {
        const u = new URL(s);
        const segs = u.pathname.split('/').filter(Boolean);
        return decodeURIComponent(segs[segs.length - 1] || u.host) || s;
    } catch {
        return s;
    }
}
