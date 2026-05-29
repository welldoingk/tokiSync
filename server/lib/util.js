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

export function readJsonBody(req, limit = 1_000_000) {
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
