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

function gmRequest(opts) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            ...opts,
            onload: (res) => resolve(res),
            onerror: (err) => reject(new Error(`[WebDAV] 네트워크 오류: ${err?.error || 'unknown'}`)),
            ontimeout: () => reject(new Error(`[WebDAV] 타임아웃: ${opts.url}`))
        });
    });
}

/**
 * WebDAV 컬렉션(폴더) 보장 — 없으면 MKCOL 생성.
 * 이미 존재(405/301/409 변형)하면 무시. 부모가 없으면 호출 순서로 보장.
 */
async function ensureCollection(url, config) {
    const res = await gmRequest({
        method: 'MKCOL',
        url,
        headers: buildHeaders(config),
        timeout: 30000
    });
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

    const catUrl = `${base}/${encodePath(cat)}`;
    const seriesUrl = `${catUrl}/${encodePath(safeSeries)}`;
    const fileUrl = `${seriesUrl}/${encodePath(safeFile)}`;

    // 1. 폴더 보장 (상위 → 하위 순서)
    await ensureCollection(catUrl, config);
    await ensureCollection(seriesUrl, config);

    // 2. PUT 업로드
    logger.log(`[WebDAV] 업로드 중... (${cat}/${safeSeries}/${safeFile}, ${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
    const res = await gmRequest({
        method: 'PUT',
        url: fileUrl,
        headers: buildHeaders(config, { 'Content-Type': blob.type || 'application/octet-stream' }),
        data: blob,
        binary: true,
        timeout: 600000
    });

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
