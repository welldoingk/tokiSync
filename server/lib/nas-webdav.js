const DEFAULT_TIMEOUT_MS = 30000;

function normalizeBase(raw) {
    return String(raw || '').trim().replace(/\/+$/, '');
}

function safeDecode(s) {
    const text = String(s || '');
    try { return decodeURIComponent(text); } catch (_) { return text; }
}

function xmlDecode(s) {
    return String(s || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function tagText(block, tag) {
    const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'i');
    const m = String(block || '').match(re);
    return m ? xmlDecode(m[1].replace(/<[^>]*>/g, '').trim()) : '';
}

function isCollection(block) {
    return /<(?:[\w.-]+:)?collection\b/i.test(String(block || ''));
}

function encodeSegment(s) {
    return encodeURIComponent(String(s || '')).replace(/%2F/gi, '/');
}

function safeSeriesName(folderName) {
    return String(folderName || '').trim().replace(/[\\/<>:"|?*]/g, '_').replace(/^\/+|\/+$/g, '');
}

function webdavUrl(baseUrl, parts) {
    const base = normalizeBase(baseUrl);
    const suffix = parts.filter((p) => String(p || '').trim()).map(encodeSegment).join('/');
    return suffix ? `${base}/${suffix}` : base;
}

function authHeaders(user, pass) {
    const headers = {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
    };
    if (user) {
        headers.Authorization = `Basic ${Buffer.from(`${user}:${pass || ''}`, 'utf8').toString('base64')}`;
    }
    return headers;
}

async function propfind(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'PROPFIND',
            headers: authHeaders(opts.user, opts.pass),
            body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>',
            signal: controller.signal,
        });
        const text = await res.text();
        return { status: res.status, text };
    } finally {
        clearTimeout(timer);
    }
}

function basenameFromHref(href) {
    const clean = safeDecode(xmlDecode(href)).split('?')[0].replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

function parseMultiStatus(xml) {
    const text = String(xml || '');
    const blocks = text.match(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) || [];
    return blocks.map((block) => {
        const href = tagText(block, 'href');
        const lenRaw = tagText(block, 'getcontentlength');
        const name = basenameFromHref(href);
        const size = Number.parseInt(lenRaw || '0', 10);
        return {
            href,
            name,
            isCollection: isCollection(block),
            size: Number.isFinite(size) ? size : 0,
        };
    }).filter((e) => e.name);
}

// 파일명에서 '회차 번호 토큰'을 뽑는다. 저장 규칙은 `<번호토큰> - <제목>.<ext>`이며
//   번호토큰은 일반 회차 "0123" 또는 외전/특별편 "0123_특별편" 형태(unit.num 그대로).
//   → ' - ' 앞부분을 통째로 토큰으로 취해 한정자(_특별편)를 보존한다(번호 충돌 방지).
//   ' - '가 없는 옛/외부 파일은 선두 숫자(소수/범위)만 폴백 추출.
function numFromFileName(name) {
    let s = String(name || '')
        .replace(/\.(cbz|cbr|zip|epub|pdf)$/i, '')
        .trim();
    if (!s) return '';
    const dash = s.indexOf(' - ');
    if (dash >= 0) {
        const token = s.slice(0, dash).trim();
        return /^\d/.test(token) ? token : '';
    }
    const m = s.match(/^(\d+(?:[.-]\d+)?(?:_\S+)?)/);
    return m ? m[1] : '';
}

// 회차 키 정규화 — 선두 숫자(소수/범위)는 0 제거해 정규화하되, 뒤따르는 한정자(_특별편 등)는
//   보존한다. 예) "0123"→"123", "0123_특별편"→"123_특별편", "0123.5"→"123.5".
//   한정자 보존으로 외전/특별편이 같은 번호의 일반 회차와 충돌(오스킵)하지 않는다.
export function normalizeEpisodeNumber(n) {
    const s = String(n || '').trim();
    if (!s) return '';
    const m = s.match(/^0*(\d+)(?:[.-](\d+))?(.*)$/);
    if (!m) return s.toLowerCase();
    const core = m[2] ? `${Number(m[1])}.${Number(m[2])}` : String(Number(m[1]));
    const rest = String(m[3] || '')
        .replace(/^[\s_.-]+/, '')
        .trim()
        .toLowerCase();
    return rest ? `${core}_${rest}` : core;
}

export async function listNasCategories(opts) {
    const baseUrl = normalizeBase(opts.webdavUrl);
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('valid webdavUrl required');
    const res = await propfind(baseUrl, opts);
    if (res.status === 401 || res.status === 403) throw new Error(`WebDAV auth failed (${res.status})`);
    if (res.status !== 207 && !(res.status >= 200 && res.status < 300)) {
        throw new Error(`WebDAV PROPFIND failed (${res.status})`);
    }
    const baseName = basenameFromHref(new URL(baseUrl).pathname);
    const categories = parseMultiStatus(res.text)
        .filter((e) => e.isCollection && e.name !== baseName)
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'ko'));
    return { folderUrl: baseUrl, categories };
}

export async function listNasSeries(opts) {
    const baseUrl = normalizeBase(opts.webdavUrl);
    const category = String(opts.category || 'Webtoon').trim() || 'Webtoon';
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('valid webdavUrl required');
    const url = webdavUrl(baseUrl, [category]);
    const res = await propfind(url, opts);
    if (res.status === 404) return { folderUrl: url, series: [] };
    if (res.status === 401 || res.status === 403) throw new Error(`WebDAV auth failed (${res.status})`);
    if (res.status !== 207 && !(res.status >= 200 && res.status < 300)) {
        throw new Error(`WebDAV PROPFIND failed (${res.status})`);
    }
    const entries = parseMultiStatus(res.text);
    const series = entries
        .filter((e) => e.isCollection && e.name !== category)
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'ko'));
    return { folderUrl: url, series };
}

export async function scanNasSeries(opts) {
    const baseUrl = normalizeBase(opts.webdavUrl);
    const category = String(opts.category || 'Webtoon').trim() || 'Webtoon';
    const series = safeSeriesName(opts.series);
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('valid webdavUrl required');
    if (!series) throw new Error('series folder required');
    const folderUrl = webdavUrl(baseUrl, [category, series]);
    const res = await propfind(folderUrl, opts);
    if (res.status === 404) {
        return { folderUrl, category, series, thresholdBytes: 0, files: [] };
    }
    if (res.status === 401 || res.status === 403) throw new Error(`WebDAV auth failed (${res.status})`);
    if (res.status !== 207 && !(res.status >= 200 && res.status < 300)) {
        throw new Error(`WebDAV PROPFIND failed (${res.status})`);
    }

    const rawFiles = parseMultiStatus(res.text)
        .filter((e) => !e.isCollection && e.name !== series)
        .map((e) => ({
            name: e.name,
            num: numFromFileName(e.name),
            numKey: normalizeEpisodeNumber(numFromFileName(e.name)),
            size: e.size,
        }))
        .filter((e) => e.numKey);

    // 손상 판별: 임계값을 '최대크기' 대신 '중앙값(median) × ratio'로 계산한다.
    //   유독 큰 회차 1개(합본/특집 등) 때문에 정상 회차들이 too-small로 오판되던 문제 방지.
    //   파일이 1개뿐이어도 절대 최소크기(ABS_MIN)는 검사 → 0바이트/잘린 단일 파일도 거른다.
    const ABS_MIN_BYTES = 1024;
    const sizes = rawFiles.map((f) => f.size || 0).sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0;
    const ratio = Math.max(0, Math.min(Number(opts.minSizeRatio ?? 0.5), 1));
    const thresholdBytes =
        rawFiles.length > 1 ? Math.max(ABS_MIN_BYTES, Math.floor(median * ratio)) : ABS_MIN_BYTES;
    const files = rawFiles.map((f) => ({
        ...f,
        valid: (f.size || 0) >= thresholdBytes,
        reason: (f.size || 0) >= thresholdBytes ? 'ok' : 'too-small',
    }));
    return { folderUrl, category, series, thresholdBytes, median, files };
}

function basicAuth(user, pass) {
    return user ? `Basic ${Buffer.from(`${user}:${pass || ''}`, 'utf8').toString('base64')}` : '';
}

async function webdavMkcol(url, opts) {
    const headers = {};
    const a = basicAuth(opts.user, opts.pass);
    if (a) headers.Authorization = a;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(url, { method: 'MKCOL', headers, signal: controller.signal });
        return res.status; // 201 created / 405·409 = already exists(무시)
    } catch (e) {
        return 0;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 조립된 파일 버퍼를 NAS WebDAV로 직접 PUT한다(서버=robocom가 LAN 직결로 저장).
 * 브라우저 GM_xmlhttpRequest의 대용량 요청-본문 한계를 우회하는 청크 릴레이의 종착점.
 */
export async function putNasFile(opts, category, folder, fileName, buffer, contentType) {
    const baseUrl = normalizeBase(opts.webdavUrl);
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('valid webdavUrl required');
    const cat = String(category || 'Webtoon').trim() || 'Webtoon';
    const safeFolder = safeSeriesName(folder) || 'TokiSync';
    const safeName = String(fileName || '').replace(/[\\/<>:"|?*]/g, '_').trim() || 'file.bin';
    // 폴더 보장 (상위 → 하위, 존재 시 405/409 무시)
    await webdavMkcol(webdavUrl(baseUrl, [cat]), opts);
    await webdavMkcol(webdavUrl(baseUrl, [cat, safeFolder]), opts);
    const fileUrl = webdavUrl(baseUrl, [cat, safeFolder, safeName]);
    const headers = { 'Content-Type': contentType || 'application/octet-stream' };
    const a = basicAuth(opts.user, opts.pass);
    if (a) headers.Authorization = a;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
        const res = await fetch(fileUrl, { method: 'PUT', headers, body: buffer, signal: controller.signal });
        if (res.status >= 200 && res.status < 300) return { status: res.status, url: fileUrl, size: buffer.length };
        if (res.status === 401 || res.status === 403) throw new Error(`WebDAV 인증 실패 (${res.status})`);
        throw new Error(`WebDAV PUT 실패 (${res.status})`);
    } finally {
        clearTimeout(timer);
    }
}
