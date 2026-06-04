/**
 * WebDAV Upload Module (NAS 직접 업로드)
 * "native(자동 분류)" 정책의 저장 대상을 GM_download → NAS WebDAV(PUT)로 대체.
 * Synology WebDAV Server 등 표준 WebDAV 대상 가정.
 *
 * 경로 매핑: <webdavUrl>/<category>/<folderName>/<fileName>
 *   예) http://192.168.0.50:5005/books/Manga/[14] 제목/0001 - 1화.cbz
 *
 * GM_xmlhttpRequest 사용 → CORS/Mixed-Content 우회 (@connect * 필요).
 */

import { getConfig } from './config.js';
import { LogBox } from './ui.js';
import { getRemoteConfigFromStore } from './lan-custom-config.js';

/** base URL 정규화 — 뒤쪽 슬래시 제거 */
function normalizeBase(url) {
    return (url || '').trim().replace(/\/+$/, '');
}

/** Basic 인증 헤더 (user 비어 있으면 인증 생략) */
function buildHeaders(config, extra = {}) {
    const headers = { ...extra };
    if (config.webdavUser) {
        // btoa는 latin1만 — UTF-8 자격증명 안전 인코딩
        const token = btoa(unescape(encodeURIComponent(`${config.webdavUser}:${config.webdavPass || ''}`)));
        headers['Authorization'] = `Basic ${token}`;
    }
    return headers;
}

/** 경로 세그먼트 URL 인코딩 (슬래시는 보존) */
function encodePath(segment) {
    return encodeURIComponent(segment);
}

function displayPath(url) {
    try {
        const u = new URL(url);
        return u.pathname;
    } catch (e) {
        return String(url || '').replace(/^https?:\/\/[^/]+/i, '');
    }
}

function gmRequest(opts, hardTimeoutMs = opts.timeout || 30000) {
    return new Promise((resolve, reject) => {
        let done = false;
        let xhr = null;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => {
            try { if (xhr && typeof xhr.abort === 'function') xhr.abort(); } catch (e) {}
            finish(reject, new Error(`[WebDAV] 하드 타임아웃(${Math.round(hardTimeoutMs / 1000)}초): ${opts.method} ${displayPath(opts.url)}`));
        }, hardTimeoutMs);
        xhr = GM_xmlhttpRequest({
            ...opts,
            onload: (res) => finish(resolve, res),
            onerror: (err) => finish(reject, new Error(`[WebDAV] 네트워크 오류: ${err?.error || 'unknown'} (${opts.method} ${displayPath(opts.url)})`)),
            ontimeout: () => finish(reject, new Error(`[WebDAV] 타임아웃: ${opts.method} ${displayPath(opts.url)}`))
        });
    });
}

async function propfindCollection(url, config) {
    return await gmRequest({
        method: 'PROPFIND',
        url,
        headers: buildHeaders(config, { 'Depth': '0', 'Content-Type': 'application/xml' }),
        data: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
        timeout: 12000
    }, 15000);
}

/**
 * WebDAV 컬렉션(폴더) 보장 — 없으면 MKCOL 생성.
 * 이미 존재(405/301/409 변형)하면 무시. 부모가 없으면 호출 순서로 보장.
 */
async function ensureCollection(url, config, label, logger) {
    if (logger && typeof logger.log === 'function') {
        logger.log(`[WebDAV] 폴더 확인: ${label}`);
    }
    try {
        const chk = await propfindCollection(url, config);
        if (chk.status === 207 || (chk.status >= 200 && chk.status < 300) || chk.status === 301 || chk.status === 302) {
            return;
        }
        if (chk.status === 401 || chk.status === 403) {
            throw new Error(`[WebDAV] 폴더 확인 인증/권한 실패 (${chk.status}): ${label}`);
        }
        if (chk.status !== 404 && logger && typeof logger.warn === 'function') {
            logger.warn(`[WebDAV] 폴더 확인 상태 ${chk.status}: ${label}`, 'WebDAV');
        }
    } catch (err) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn(`[WebDAV] 폴더 확인 실패, MKCOL 시도: ${label} (${err.message})`, 'WebDAV');
        }
    }

    const res = await gmRequest({
        method: 'MKCOL',
        url,
        headers: buildHeaders(config),
        timeout: 30000
    }, 35000);
    // 201 Created = 생성됨, 405 Method Not Allowed = 이미 존재(대부분 서버), 301 = 존재
    if (res.status === 201 || res.status === 405 || res.status === 301) return;
    // 일부 서버는 이미 존재 시 409를 주기도 하나, 보통 부모 부재. 그래도 진행 시도.
    if (res.status === 409) {
        console.warn(`[WebDAV] MKCOL 409 (부모 부재 가능): ${url}`);
        return;
    }
    if (res.status === 401 || res.status === 403) {
        throw new Error(`[WebDAV] 인증 실패 (${res.status}). 계정/권한을 확인하세요.`);
    }
    // 그 외 상태는 경고만 — PUT 단계에서 최종 판정
    console.warn(`[WebDAV] MKCOL 예상치 못한 상태 ${res.status}: ${url}`);
}

/** Uint8Array → base64 (콜스택 안전, 청크 단위 변환) */
function bytesToBase64(bytes) {
    let bin = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(bin);
}

/**
 * 대용량 파일을 robocom 컨트롤 API로 청크 전송하고, 서버가 LAN으로 NAS에 PUT한다.
 * 브라우저 GM_xmlhttpRequest가 대용량 요청-본문을 못 보내는 한계(원격/Tampermonkey)를 우회.
 * 청크 512KB(base64 ~683KB, 서버 readJsonBody 1MB 한도 내) + 동시 4병렬 전송으로 속도 향상.
 * 메타는 첫 청크(seq 0)에 동봉해 선전송→서버 세션 확정 후 나머지를 병렬 전송(서버는 순서 무관 조립).
 */
async function uploadViaRelay(blob, category, folderName, fileName, remote, config, logger) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 512 * 1024;
    const PARALLEL = 4;
    const total = Math.max(1, Math.ceil(buf.length / CHUNK));
    const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const base = (remote.url || '').replace(/\/+$/, '');
    const meta = {
        webdavUrl: config.webdavUrl,
        user: config.webdavUser,
        pass: config.webdavPass,
        category: (category || 'Webtoon').toString(),
        folder: (folderName || 'TokiSync').toString(),
        fileName: fileName,
        contentType: blob.type || 'application/octet-stream',
        totalSize: buf.length,
    };

    const sendChunk = async (seq, withMeta) => {
        const slice = buf.subarray(seq * CHUNK, Math.min(buf.length, (seq + 1) * CHUNK));
        const payload = { uploadId, seq, total, chunkB64: bytesToBase64(slice) };
        if (withMeta) payload.meta = meta;
        const headers = { 'Content-Type': 'application/json' };
        if (remote.token) headers['Authorization'] = `Bearer ${remote.token}`;
        const res = await gmRequest({
            method: 'POST',
            url: `${base}/nas/upload`,
            headers,
            data: JSON.stringify(payload),
            timeout: 45000
        }, 50000);
        if (res.status < 200 || res.status >= 300) {
            let detail = '';
            try { detail = JSON.parse(res.responseText || '{}').error || ''; } catch (e) {}
            throw new Error(`[WebDAV] 릴레이 청크 ${seq + 1}/${total} 실패 (${res.status}) ${detail}`);
        }
        try { return JSON.parse(res.responseText || '{}'); } catch (e) { return {}; }
    };

    logger.log(`[WebDAV] 릴레이 업로드 중... (${meta.category}/${meta.folder}/${fileName}, ${(buf.length / 1024 / 1024).toFixed(1)}MB, ${total}청크 ·${PARALLEL}병렬)`);

    // 1) 첫 청크(메타 포함) 선전송 → 서버 세션/메타 확정
    let r0 = await sendChunk(0, true);
    if (r0 && r0.done) { logger.success(`[WebDAV] ✅ 업로드 완료(릴레이): ${fileName}`); return true; }

    // 2) 나머지 청크를 PARALLEL개씩 병렬 전송 (서버는 seq로 순서 무관 조립)
    for (let start = 1; start < total; start += PARALLEL) {
        const batch = [];
        for (let seq = start; seq < Math.min(total, start + PARALLEL); seq++) batch.push(sendChunk(seq, false));
        const results = await Promise.all(batch);
        if (results.some((r) => r && r.done)) break;
    }
    logger.success(`[WebDAV] ✅ 업로드 완료(릴레이): ${fileName}`);
    return true;
}

/**
 * 파일을 NAS WebDAV로 업로드 (카테고리/시리즈 폴더 자동 생성 후 PUT).
 * @param {Blob} blob 업로드 데이터
 * @param {string} category "Manga" | "Webtoon" | "Novel" 등
 * @param {string} folderName 시리즈 폴더명 (예: "[14] 제목")
 * @param {string} fileName 파일명 (확장자 포함, 예: "0001 - 1화.cbz")
 */
export async function uploadWebDav(blob, category, folderName, fileName) {
    const config = getConfig();
    const logger = LogBox.getInstance();
    const base = normalizeBase(config.webdavUrl);

    if (!base) {
        throw new Error('[WebDAV] 업로드 URL이 설정되지 않았습니다. 설정에서 NAS WebDAV URL을 입력하세요.');
    }

    const cat = (category || 'Webtoon').toString();
    const series = (folderName || 'TokiSync').toString();
    // 파일명/폴더명에 슬래시·역슬래시 등 경로 위험 문자 제거
    const safeSeries = series.replace(/[\\/<>:"|?*]/g, '_');
    const safeFile = fileName.replace(/[\\/<>:"|?*]/g, '_');

    // 원격(멀티-IP) 워커는 브라우저에서 NAS로 직접 대용량 PUT이 막히므로(GM_xhr 본문 한계),
    // robocom 컨트롤 API로 청크 전송 → 서버가 LAN으로 NAS 저장(릴레이). 원격 URL 미설정 시 직접 PUT.
    const remote = getRemoteConfigFromStore(typeof GM_getValue !== 'undefined' ? GM_getValue : null);
    if (remote && remote.url) {
        return await uploadViaRelay(blob, cat, safeSeries, safeFile, remote, config, logger);
    }

    const catUrl = `${base}/${encodePath(cat)}`;
    const seriesUrl = `${catUrl}/${encodePath(safeSeries)}`;
    const fileUrl = `${seriesUrl}/${encodePath(safeFile)}`;

    // 1. 폴더 보장 (상위 → 하위 순서)
    await ensureCollection(catUrl, config, cat, logger);
    await ensureCollection(seriesUrl, config, `${cat}/${safeSeries}`, logger);

    // 2. PUT 업로드
    //   대용량 Blob을 GM_xmlhttpRequest로 그대로 보내면 일부 Tampermonkey/Chrome 조합에서
    //   page→background 마샬링이 멈추는 사례가 있어 ArrayBuffer로 변환해 전송한다.
    //   (브라우저 밖 curl PUT은 정상이므로 OS/NAS가 아닌 GM 전송 계층을 회피 + 짧은 타임아웃으로 좀비 방지)
    logger.log(`[WebDAV] 업로드 중... (${cat}/${safeSeries}/${safeFile}, ${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
    const body = await blob.arrayBuffer();
    let res;
    try {
        res = await gmRequest({
            method: 'PUT',
            url: fileUrl,
            headers: buildHeaders(config, { 'Content-Type': blob.type || 'application/octet-stream' }),
            data: body,
            timeout: 30000
        }, 35000);
    } catch (err) {
        // 전송이 멈추거나 응답을 못 받아도 본문이 NAS에 실제로 올라간 경우가 있어, PROPFIND로 적재(크기 일치)를 검증한다.
        logger.warn(`[WebDAV] PUT 응답 이상(${err.message}) → 실제 적재 검증 시도`, 'WebDAV');
        try {
            const chk = await gmRequest({
                method: 'PROPFIND',
                url: fileUrl,
                headers: buildHeaders(config, { 'Depth': '0', 'Content-Type': 'application/xml' }),
                data: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>',
                timeout: 15000
            }, 18000);
            const m = /getcontentlength>(\d+)</i.exec(chk.responseText || '');
            if (m && Number(m[1]) === blob.size) {
                logger.success(`[WebDAV] ✅ 업로드 확인됨(검증, ${(blob.size / 1024 / 1024).toFixed(1)}MB): ${safeFile}`);
                return true;
            }
        } catch (e2) {}
        throw err;
    }

    if (res.status >= 200 && res.status < 300) {
        logger.success(`[WebDAV] ✅ 업로드 완료: ${safeFile}`);
        return true;
    }
    if (res.status === 401 || res.status === 403) {
        throw new Error(`[WebDAV] 인증/권한 실패 (${res.status})`);
    }
    if (res.status === 409) {
        throw new Error(`[WebDAV] 폴더 생성 실패로 PUT 거부 (409): ${fileUrl}`);
    }
    throw new Error(`[WebDAV] 업로드 실패 (${res.status}): ${(res.responseText || '').slice(0, 200)}`);
}

/**
 * PROPFIND로 시리즈 폴더의 기존 파일 목록+용량을 조회.
 * Drive의 fetchHistoryDirect와 동일한 Smart-Skip 휴리스틱 적용.
 * @returns {Promise<{success: boolean, folderId: string|null, data: string[]}>}
 *   folderId 자리에는 시리즈 폴더 URL을 반환(폴백 검사용).
 */
export async function fetchHistoryWebDav(folderName, category = 'Webtoon') {
    const config = getConfig();
    const logger = LogBox.getInstance();
    const base = normalizeBase(config.webdavUrl);
    if (!base) return { success: false, folderId: null, data: [] };

    const safeSeries = (folderName || '').replace(/[\\/<>:"|?*]/g, '_');
    const seriesUrl = `${base}/${encodePath((category || 'Webtoon').toString())}/${encodePath(safeSeries)}`;

    try {
        const res = await gmRequest({
            method: 'PROPFIND',
            url: seriesUrl,
            headers: buildHeaders(config, { 'Depth': '1', 'Content-Type': 'application/xml' }),
            data: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>',
            timeout: 30000
        });

        // 404 = 폴더 없음(첫 업로드) → 정상, 빈 목록
        if (res.status === 404) {
            return { success: true, folderId: seriesUrl, data: [] };
        }
        // 207 Multi-Status = 정상
        if (res.status !== 207 && !(res.status >= 200 && res.status < 300)) {
            if (res.status === 401 || res.status === 403) {
                logger.warn(`[WebDAV] 기록 조회 인증 실패 (${res.status})`, 'WebDAV:History');
            }
            return { success: false, folderId: seriesUrl, data: [] };
        }

        const doc = new DOMParser().parseFromString(res.responseText, 'application/xml');
        const responses = Array.from(doc.getElementsByTagNameNS('DAV:', 'response'));

        const fileInfos = [];
        let maxSize = 0;
        for (const r of responses) {
            const hrefEl = r.getElementsByTagNameNS('DAV:', 'href')[0];
            const lenEl = r.getElementsByTagNameNS('DAV:', 'getcontentlength')[0];
            if (!hrefEl) continue;
            // 컬렉션 자신(getcontentlength 없음)은 스킵
            if (!lenEl || lenEl.textContent === '') continue;

            const href = decodeURIComponent(hrefEl.textContent || '');
            const name = href.replace(/\/+$/, '').split('/').pop();
            const m = name && name.match(/^(\d+)/);
            if (!m) continue;

            const sizeBytes = parseInt(lenEl.textContent || '0', 10);
            if (sizeBytes > maxSize) maxSize = sizeBytes;
            fileInfos.push({ num: m[1], name, size: sizeBytes });
        }

        if (fileInfos.length === 0) return { success: true, folderId: seriesUrl, data: [] };

        let threshold = 0;
        if (maxSize > 0 && fileInfos.length > 1) {
            const ratio = (config.smartSkipRatio !== undefined ? config.smartSkipRatio : 50) / 100;
            threshold = maxSize * ratio;
            logger.log(`[WebDAV SmartSkip] Max: ${(maxSize / 1024 / 1024).toFixed(1)}MB, 통과 기준: ${config.smartSkipRatio || 50}% (${(threshold / 1024 / 1024).toFixed(1)}MB 이상)`);
        }

        const validEpisodes = [];
        const ignored = [];
        for (const info of fileInfos) {
            if (info.size >= threshold) validEpisodes.push(info.num);
            else ignored.push(info.name);
        }
        if (ignored.length > 0) {
            logger.warn(`[WebDAV SmartSkip] ⚠️ 용량 미달(손상 의심) ${ignored.length}개 재다운로드 대상`, 'WebDAV:History');
        }

        return {
            success: true,
            folderId: seriesUrl,
            data: [...new Set(validEpisodes)].sort((a, b) => parseInt(a) - parseInt(b))
        };
    } catch (err) {
        logger.warn(`[WebDAV] 기록 조회 실패: ${err.message}`, 'WebDAV:History');
        return { success: false, folderId: seriesUrl, data: [] };
    }
}

/** Drive isConfigValid에 대응 — WebDAV 설정 유효성 */
export function isWebDavConfigValid() {
    const config = getConfig();
    return !!normalizeBase(config.webdavUrl);
}
