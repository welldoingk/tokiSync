/**
 * 원격 제어 폴링 어댑터
 *
 * 컨트롤 API 서버(server/control-api.js)를 주기적으로 폴링해서:
 *   - 명령(add/start/stop/clear/remove)을 받아 로컬 큐(queue.js)에 적용
 *   - 로컬 큐/실행상태/진행률을 POST /progress 로 미러 보고 (대시보드 표시용)
 *   - 캡차 감지 이벤트 수신 시 POST /captcha 로 보고 (서버가 텔레그램 발송)
 *
 * 설계 원칙:
 *   - 서버는 "원격 제어 평면(control plane)", 로컬 GM 큐는 "실행 엔진".
 *   - 명령은 단조 증가 seq를 가지며, 적용한 마지막 seq를 GM에 영속화해 중복 적용 방지.
 *   - 'start' 명령은 페이지 내비게이션(reload)을 유발하므로 적용 전에 seq를 먼저 저장
 *     → 새로고침 후 같은 명령이 재실행되어 무한 reload되는 것을 방지.
 *   - 최초 부착(lastSeq 미설정) 시에는 서버의 현재 seq를 기준선으로 채택하고
 *     과거 명령 백로그는 재생하지 않는다(스크립트 재시작 시 옛 URL 재추가 방지).
 */
import {
    addUrls,
    addLeasedUnits,
    startQueue,
    stopQueue,
    clearQueue,
    getQueue,
    saveQueue,
    isRunning,
    pathKey,
} from './queue.js';
import {
    getRemoteConfig,
    CFG_REMOTE_ENABLED,
    CFG_REMOTE_API_URL,
    CFG_REMOTE_API_TOKEN,
    CFG_REMOTE_POLL_SEC,
    CFG_REMOTE_CLIENT_ID,
    CFG_REMOTE_LEASE_MAX,
} from './config.js';
import { tokiAlert } from './ui.js';
import { ParserFactory } from './parsers/ParserFactory.js';
import { getCommonPrefix } from './utils.js';

const K_LAST_SEQ = 'TOKI_REMOTE_LAST_SEQ';
const K_DONE_EXP = 'TOKI_REMOTE_DONE_EXPANSIONS'; // 이미 처리한 expand 요청 id (중복 펼침 방지)

let _timer = null;
let _started = false;
let _lastProgress = null;
let _externalIp = '';   // 외부 IP(식별/검증용, 1회 조회 후 캐시)
let _ipQueried = false;

function _gv(k, d) {
    try { return typeof GM_getValue !== 'undefined' ? GM_getValue(k, d) : d; }
    catch { return d; }
}
function _sv(k, v) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(k, v); } catch {}
}

function base(url) { return (url || '').replace(/\/+$/, ''); }

/** GM_xmlhttpRequest 기반 요청 (Promise). raw=true 면 응답 본문 문자열을 그대로 반환(HTML 등). */
function gmRequest({ method, url, token, data, raw }) {
    return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined') {
            reject(new Error('GM_xmlhttpRequest unavailable'));
            return;
        }
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-Toki-Token'] = token;
        GM_xmlhttpRequest({
            method,
            url,
            headers: raw ? {} : headers,
            data: data ? JSON.stringify(data) : undefined,
            timeout: raw ? 25000 : 15000,
            onload: (r) => {
                if (raw) {
                    if (r.status >= 200 && r.status < 300) resolve(r.responseText || '');
                    else reject(new Error(`HTTP ${r.status}`));
                    return;
                }
                let j = {};
                try { j = r.responseText ? JSON.parse(r.responseText) : {}; } catch {}
                if (r.status >= 200 && r.status < 300) resolve(j);
                else reject(new Error(`HTTP ${r.status}: ${j.error || ''}`));
            },
            onerror: () => reject(new Error('network error')),
            ontimeout: () => reject(new Error('timeout')),
        });
    });
}

/**
 * 작품 메인(목록) 페이지 문서에서 회차 URL들을 추출.
 *   회차 URL 패턴 = 시리즈 경로 + "/숫자" (예: /manhwa/14 → /manhwa/14/1451, /novel/57328 → /novel/57328/503...).
 *   사이트 룰 없이도 동작하는 범용 규칙. document 순서(=회차 순서) 보존, 중복 제거.
 */
function extractChapterUrls(doc, seriesUrl) {
    let basePath, origin;
    try { const u = new URL(seriesUrl); basePath = u.pathname.replace(/\/+$/, ''); origin = u.origin; }
    catch { return []; }
    if (!basePath) return [];
    const re = new RegExp('^' + basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/\\d+$');
    const seen = new Set();
    const out = [];
    const anchors = doc.querySelectorAll('a[href]');
    for (const a of anchors) {
        const href = a.getAttribute('href');
        if (!href) continue;
        let abs, path;
        try { const u = new URL(href, seriesUrl); abs = u.origin + u.pathname; path = u.pathname.replace(/\/+$/, ''); }
        catch { continue; }
        if (!re.test(path)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);
        out.push(abs);
    }
    return out;
}

/**
 * seriesUrl HTML을 받아 회차 URL 추출.
 *   ⚠️ GM_xmlhttpRequest 는 브라우저 지문이 부족해 Cloudflare 403 challenge 에 걸린다(실측).
 *   → 페이지 내 window.fetch(credentials:'include') 를 우선 사용: same-origin 이고 cf_clearance
 *     쿠키·브라우저 지문이 그대로 실려 Cloudflare 를 통과한다(실측: 200 + 회차 265개).
 *   비-Cloudflare/cross-origin 사이트를 위해 실패 시 GM_xmlhttpRequest 로 폴백.
 */
async function fetchChapterUrls(seriesUrl) {
    let html = '';
    try {
        const r = await fetch(seriesUrl, { credentials: 'include' });
        if (r.ok) html = await r.text();
    } catch (e) { /* cross-origin(CORS) 등 → 폴백 */ }
    if (!html || /just a moment|challenge-platform|cf-mitigated/i.test(html)) {
        try { html = await gmRequest({ method: 'GET', url: seriesUrl, raw: true }); } catch (e) {}
    }
    if (!html) return { urls: [], doc: null };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { urls: extractChapterUrls(doc, seriesUrl), doc };
}

/** 현재(라이브) 시리즈 페이지에서 정식 폴더명([id] 작품명) 계산 — bulk 다운로드와 동일 규칙(getFormattedTitle). */
async function computeSeriesFolderLive() {
    try {
        const parser = await ParserFactory.getParser();
        if (!parser || !parser.getFormattedTitle) return '';
        const seriesId = parser.getSeriesId ? parser.getSeriesId() : '';
        const list = (parser.getListItems ? await parser.getListItems() : []) || [];
        if (!list.length) return '';
        const first = parser.parseListItem(list[0]);
        const last = parser.parseListItem(list[list.length - 1]);
        return parser.getFormattedTitle(seriesId, first.title, last.title, getCommonPrefix) || '';
    } catch (e) { return ''; }
}

/** 가져온 시리즈 HTML(doc)에서 best-effort 폴더명([id] 제목) — 자동 펼침용(라이브 파서 불가). */
function seriesFolderFromDoc(doc, seriesUrl) {
    let id = '';
    try {
        const m = new URL(seriesUrl).pathname.match(/\/(?:manhwa|manga|webtoon|novel|comic|toon)\/(\d+)/i);
        if (m) id = m[1];
    } catch (e) {}
    let name = ((doc && doc.title) || '').replace(/\s*[|｜].*$/, '').trim();
    const dash = name.split(/\s+-\s+/); // "작품명 - 작가" → 작품명
    if (dash.length > 1) name = dash[0].trim();
    if (!name) return '';
    return id ? `[${id}] ${name}` : name;
}

/**
 * 자동 펼침용: fetch 한 시리즈 HTML(doc)에 라이브 파서 룰(rule.list)을 직접 적용해
 *   회차 {url, num, label} 추출 → 권위 회차번호/제목 동봉(자동 펼침도 정확 명명).
 *   getListItems() 는 전역 document 의존이라 fetch된 doc 엔 못 쓰지만, parseListItem(el)/
 *   _extractValue(el,...) 는 el 기반이라 임의 doc 요소에 재사용 가능하다. 동일 사이트(파서 룰 일치) 전제.
 *   실패(룰 없음/컨테이너 없음/항목 0/예외)면 null 반환 → 호출부가 문자열 url 폴백.
 */
async function extractChapterItemsFromDoc(doc, seriesUrl) {
    try {
        if (!doc) return null;
        const parser = await ParserFactory.getParser();
        const listCfg = parser && parser.rule && parser.rule.list;
        if (!listCfg || !listCfg.container || !listCfg.item || typeof parser.parseListItem !== 'function') return null;
        const container = doc.querySelector(listCfg.container);
        if (!container) return null;
        const els = Array.from(container.querySelectorAll(listCfg.item));
        if (!els.length) return null;
        let origin = '';
        try { origin = new URL(seriesUrl).origin; } catch (e) {}
        const seen = new Set();
        const out = [];
        for (const el of els) {
            let it;
            try { it = parser.parseListItem(el); } catch (e) { continue; }
            if (!it || !it.src) continue;
            // parseListItem 의 src 는 파서 getAbsoluteUrl(현재 location origin 기준)일 수 있다 →
            //   pathname(+search)만 취해 seriesUrl origin 에 재결합(동일 사이트 자동 펼침에 안전).
            let url;
            try { const p = new URL(it.src, seriesUrl); url = (origin || p.origin) + p.pathname + (p.search || ''); }
            catch (e) { continue; }
            if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
            seen.add(url);
            out.push({ url, num: it.num || '', label: it.title || '' });
        }
        return out.length ? out : null;
    } catch (e) { return null; }
}

/**
 * 시리즈를 회차로 펼쳐 /jobs 에 투입(각 unit에 정식 폴더명 series 동봉).
 * @param series 폴더명 오버라이드(버튼이 라이브 파서로 계산해 넘김). 없으면 가져온 doc에서 best-effort.
 */
async function expandSeriesToJobs(cfg, seriesUrl, series, itemsOverride) {
    let items = itemsOverride, doc = null;
    if (!items) {
        const r = await fetchChapterUrls(seriesUrl);
        doc = r.doc;
        // 자동 펼침도 권위 회차번호/제목 동봉: 파서 룰을 fetch된 doc 에 재사용 시도.
        //   성공 → units({url,num,label}), 실패 → 문자열 url 폴백(번호/제목 best-effort, 옛 동작).
        const rich = await extractChapterItemsFromDoc(doc, seriesUrl);
        items = (rich && rich.length) ? rich : r.urls;
    }
    if (!items || !items.length) return { added: 0, skipped: 0, count: 0, folder: '' };
    const folder = series || (doc ? seriesFolderFromDoc(doc, seriesUrl) : '');
    // items 가 객체({url,num,label})면 권위 번호/제목 동봉(units), 문자열이면 urls.
    const data = { series: folder || '' };
    if (typeof items[0] === 'object') data.units = items; else data.urls = items;
    const r = await gmRequest({
        method: 'POST',
        url: `${base(cfg.url)}/jobs`,
        token: cfg.token,
        data,
    });
    return { added: r.added || 0, skipped: r.skipped || 0, count: items.length, folder };
}

/** heartbeat 응답의 expand 요청들을 처리(이미 처리한 id는 건너뜀, 멱등). */
async function processExpansions(cfg, expansions) {
    if (!Array.isArray(expansions) || !expansions.length) return;
    let done = {};
    try { done = JSON.parse(_gv(K_DONE_EXP, '{}')) || {}; } catch {}
    let changed = false;
    for (const ex of expansions) {
        if (!ex || !ex.id || done[ex.id] || !ex.seriesUrl) continue;
        try {
            const r = await expandSeriesToJobs(cfg, ex.seriesUrl, ex.series);
            done[ex.id] = 1;
            changed = true;
            try { console.log(`[TokiSync-Remote] expand ${ex.seriesUrl} → 회차 ${r.count}개 (추가 ${r.added}, 중복 ${r.skipped})`); } catch {}
        } catch (e) {
            // 실패 시 done 미표시 → 다음 heartbeat 재시도(일시 오류 대응).
            const m = e && e.message ? e.message : '';
            try { console.warn('[TokiSync-Remote] expand 실패(재시도 예정):', ex.seriesUrl, m); } catch {}
        }
    }
    if (changed) {
        // done 맵 비대화 방지: 100개 초과 시 최근 50개만 유지.
        const ids = Object.keys(done);
        if (ids.length > 100) { const keep = ids.slice(-50); const nd = {}; for (const k of keep) nd[k] = 1; done = nd; }
        _sv(K_DONE_EXP, JSON.stringify(done));
    }
}

function applyCommand(cmd) {
    switch (cmd.type) {
        case 'add':
            if (cmd.payload && cmd.payload.urls) {
                const text = Array.isArray(cmd.payload.urls)
                    ? cmd.payload.urls.join('\n')
                    : String(cmd.payload.urls);
                addUrls(text);
            }
            break;
        case 'start':
            // 무인 상태에서 startQueue()가 'pending 없음' tokiAlert 팝업을 띄워 블로킹하는 것 방지:
            // 실제 대기 항목이 있을 때만 시작(내비게이션/리로드 유발).
            if (!isRunning() && getQueue().some((i) => i.status === 'pending')) startQueue();
            break;
        case 'stop':
            stopQueue();
            break;
        case 'clear':
            clearQueue();
            break;
        case 'remove':
            if (cmd.payload && cmd.payload.url) {
                // addUrls와 동일한 pathKey 기준으로 매칭(trailing slash/도메인 미러 차이로 삭제 누락 방지)
                const key = pathKey(cmd.payload.url);
                const q = getQueue().filter((i) => pathKey(i.url) !== key);
                saveQueue(q);
            }
            break;
        default:
            break;
    }
}

/** 폴링 디스패처 — clientId 설정 시 lease 모드, 아니면 레거시 글로벌 /queue 모드(하위호환). */
async function poll() {
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;
    if (cfg.clientId) return pollLease(cfg);
    return pollLegacy(cfg);
}

/** 레거시 단일 클라 모드 — 글로벌 /queue 명령 스트림 폴링 + /progress 미러. */
async function pollLegacy(cfg) {
    let lastSeq = parseInt(_gv(K_LAST_SEQ, '-1'), 10);
    if (isNaN(lastSeq)) lastSeq = -1;

    let data;
    try {
        data = await gmRequest({
            method: 'GET',
            url: `${base(cfg.url)}/queue?since=${lastSeq}`,
            token: cfg.token,
        });
    } catch (e) {
        // 서버 오프라인/일시 오류 → 다음 주기에 재시도
        return;
    }

    if (lastSeq < 0) {
        // 최초 부착: 현재 seq를 기준선으로 채택, 백로그 미적용
        const baseSeq = typeof data.seq === 'number' ? data.seq : 0;
        _sv(K_LAST_SEQ, String(baseSeq));
    } else if (Array.isArray(data.commands) && data.commands.length) {
        const cmds = data.commands
            .filter((c) => c.seq > lastSeq)
            .sort((a, b) => a.seq - b.seq);
        for (const c of cmds) {
            // 내비게이션 안전: 적용 전에 seq 영속화
            _sv(K_LAST_SEQ, String(c.seq));
            try { applyCommand(c); } catch {}
        }
    }

    // 로컬 상태 미러 보고
    try {
        await gmRequest({
            method: 'POST',
            url: `${base(cfg.url)}/progress`,
            token: cfg.token,
            data: { queue: getQueue(), running: isRunning(), progress: _lastProgress },
        });
    } catch (e) {
        // 네트워크 오류는 무시(오프라인). 단 인증/서버 오류(4xx/5xx)는 설정 진단을 위해 로그.
        const m = e && e.message ? e.message : '';
        if (/^HTTP [45]/.test(m)) {
            try { console.warn('[TokiSync-Remote] progress 보고 실패:', m); } catch {}
        }
    }
}

/**
 * 멀티-IP lease 모드 — 작업 분배(work-stealing).
 *  ① 완료(done/error)된 unit을 /complete로 보고 → 성공 시 로컬 큐에서 제거.
 *  ② pending unit이 부족하면 /lease로 보충해 로컬 큐에 주입(중복 없는 회차 자동 분배).
 *  ③ /progress로 clientId·외부IP·진행률·보유 unit heartbeat(서버가 lease TTL 갱신).
 * 페이지 내비게이션을 거쳐도 unitId가 GM 큐에 영속되므로 완료 매핑/재투입이 안전하게 이어진다.
 */
async function pollLease(cfg) {
    // ① 완료 보고 — unitId가 붙은 큐 항목 중 done/error 수집
    const q = getQueue();
    const finished = q.filter((i) => i.unitId && (i.status === 'done' || i.status === 'error'));
    if (finished.length) {
        const results = finished.map((i) => ({ id: i.unitId, ok: i.status === 'done' }));
        try {
            await gmRequest({
                method: 'POST',
                url: `${base(cfg.url)}/complete`,
                token: cfg.token,
                data: { clientId: cfg.clientId, results },
            });
            // 보고 성공 → 종결 항목 제거(큐 비대화 방지). 서버는 중복 /complete를 멱등 무시하므로
            // 제거 전에 네비게이션이 끼어도 다음 폴에서 재보고 후 정리되어 유실 없음.
            const doneIds = new Set(finished.map((i) => i.unitId));
            saveQueue(getQueue().filter((i) => !(i.unitId && doneIds.has(i.unitId) && (i.status === 'done' || i.status === 'error'))));
        } catch (e) {
            // 실패 시 제거하지 않고 다음 주기 재시도(at-least-once 보고).
        }
    }

    // ② 임대 보충 — pending unit 수가 목표(leaseMax) 미만이면 부족분만큼 요청
    let startAfter = false;
    const pendingUnits = getQueue().filter((i) => i.unitId && i.status === 'pending').length;
    if (pendingUnits < cfg.leaseMax) {
        const want = cfg.leaseMax - pendingUnits;
        try {
            const res = await gmRequest({
                method: 'GET',
                url: `${base(cfg.url)}/lease?clientId=${encodeURIComponent(cfg.clientId)}&max=${want}`,
                token: cfg.token,
            });
            const units = Array.isArray(res.units) ? res.units : [];
            const added = addLeasedUnits(units);
            // 임대분이 생겼고 큐가 정지 상태면 시작 예약(내비게이션은 heartbeat 발사 후로 미룬다)
            if (added > 0 && !isRunning() && getQueue().some((i) => i.status === 'pending')) {
                startAfter = true;
            }
        } catch (e) {
            const m = e && e.message ? e.message : '';
            if (/^HTTP [45]/.test(m)) {
                try { console.warn('[TokiSync-Remote] lease 실패:', m); } catch {}
            }
        }
    }
    // lease 모드 in-place 처리(부모 고정)에서는 한 배치 종료 시 running=false 로 내려간다. 이때 보유 pending 이 남아 있으면
    //   (이미 leaseMax 라 신규 added 가 0 이라도) 다음 배치를 위해 재시작이 필요하다 → added 여부와 무관하게 재개 트리거.
    //   레거시 navigation 모드도 "pending 존재 + 정지" 면 동일하게 재시작(굶음 방지)하므로 의미가 보존된다.
    if (!startAfter && !isRunning() && getQueue().some((i) => i.unitId && i.status === 'pending')) {
        startAfter = true;
    }

    // ③ heartbeat — clientId/외부IP/진행률/보유 unit 보고(서버가 해당 클라의 모든 leased unit TTL 갱신).
    //    내비게이션(startQueue) 전에 반드시 발사 → 임대 직후 페이지 전환으로 lease가 굶지 않게 한다.
    const cur = getQueue();
    const current = cur.filter((i) => i.unitId && i.status === 'pending').map((i) => i.unitId);
    let hbRes = null;
    try {
        hbRes = await gmRequest({
            method: 'POST',
            url: `${base(cfg.url)}/progress`,
            token: cfg.token,
            data: {
                clientId: cfg.clientId,
                label: cfg.clientId,
                ip: await ensureExternalIp(),
                queue: cur,
                running: isRunning(),
                progress: _lastProgress,
                current,
            },
        });
    } catch (e) {
        const m = e && e.message ? e.message : '';
        if (/^HTTP [45]/.test(m)) {
            try { console.warn('[TokiSync-Remote] heartbeat 실패:', m); } catch {}
        }
    }

    // ⑤ 정지(paused) — 서버가 정지 상태면 로컬 큐를 멈추고 이번 주기 종료(새 작업/시작 안 함).
    if (hbRes && hbRes.paused) {
        try { if (isRunning()) stopQueue(); } catch (e) {}
        return;
    }

    // ④ 작품 자동 펼침 — heartbeat 응답의 expand 요청을 처리(Cloudflare 통과한 이 브라우저가
    //    회차 목록을 받아 /jobs 로 투입). 멱등이라 다른 클라가 동시에 처리해도 중복은 흡수된다.
    if (hbRes && Array.isArray(hbRes.expansions) && hbRes.expansions.length) {
        try { await processExpansions(cfg, hbRes.expansions); } catch (e) {}
    }

    // heartbeat가 끝난 뒤에야 큐를 시작(내비게이션 유발) → 이번 주기의 lease TTL 갱신이 항상 선행된다.
    if (startAfter && !isRunning() && getQueue().some((i) => i.status === 'pending')) {
        startQueue();
    }
}

/** 외부 IP 1회 조회(식별/검증용, 선택). 실패해도 ''로 폴백 — IP 표시는 best-effort. */
async function ensureExternalIp() {
    if (_ipQueried) return _externalIp;
    _ipQueried = true;
    try {
        const r = await gmRequest({ method: 'GET', url: 'https://api.ipify.org?format=json' });
        if (r && typeof r.ip === 'string') _externalIp = r.ip;
    } catch { /* @connect 미허용/오프라인 → 빈 문자열 유지 */ }
    return _externalIp;
}

function onCaptcha() {
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;
    gmRequest({
        method: 'POST',
        url: `${base(cfg.url)}/captcha`,
        token: cfg.token,
        data: {
            // clientId가 있으면 서버가 해당 클라의 lease를 즉시 재투입(다른 클라는 계속).
            clientId: cfg.clientId || undefined,
            message: '⚠️ tokiSync 캡차 감지 — 원격에서 브라우저 확인 필요',
            url: location.href,
        },
    }).catch(() => {});
}

function onProgress(e) {
    _lastProgress = (e && e.detail) || null;
}

/** 큐 폴링 시작 (top window 한정) */
export function startRemoteSync() {
    if (_started) return;
    if (window.self !== window.top) return;
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;
    _started = true;

    window.addEventListener('toki:captcha', onCaptcha);
    window.addEventListener('toki:progress', onProgress);
    // 백업: 팝업이 top까지 보낸 캡차 postMessage도 포착
    window.addEventListener('message', (ev) => {
        if (ev && ev.data && ev.data.type === 'TOKI_CAPTCHA_DETECTED') onCaptcha();
    });

    poll();
    _timer = setInterval(poll, cfg.pollSec * 1000);
    try { console.log(`[TokiSync-Remote] polling ${base(cfg.url)} every ${cfg.pollSec}s`); } catch {}
}

/** GM 메뉴에 원격 설정 등록 */
export function registerRemoteMenu() {
    try {
        if (typeof GM_registerMenuCommand !== 'undefined' && window.self === window.top) {
            GM_registerMenuCommand('🌐 원격 제어 설정', openRemoteModal);
            GM_registerMenuCommand('📤 이 작품 전체 회차 → 원격 풀 투입', onExpandCurrentSeries);
        }
    } catch {}
}

/** [버튼] 현재 작품(목록) 페이지의 전체 회차를 추출해 원격 lease 풀(/jobs)에 투입. */
async function onExpandCurrentSeries() {
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) {
        tokiAlert('먼저 🌐 원격 제어 설정에서 컨트롤 API 주소/토큰을 설정하고 활성화하세요.');
        return;
    }
    // 라이브 파서로 회차 목록 추출 — 각 회차의 권위 번호(num)/제목(title)을 함께 가져온다
    //   (외전·소수회차도 정확히 명명). 파서 실패 시 generic anchor 추출로 폴백.
    let items = [];
    try {
        const parser = await ParserFactory.getParser();
        const list = (parser && parser.getListItems) ? (await parser.getListItems()) || [] : [];
        if (list.length && parser.parseListItem) {
            items = list.map((li) => { const it = parser.parseListItem(li); return { url: it.src, num: it.num, label: it.title }; })
                        .filter((u) => u.url && /^https?:\/\//i.test(u.url));
        }
    } catch (e) {}
    if (!items.length) items = extractChapterUrls(document, location.href); // 폴백(문자열 url들)
    if (!items.length) {
        tokiAlert('이 페이지에서 회차 목록을 찾지 못했습니다.\n작품 메인(회차 목록) 페이지에서 실행하세요.');
        return;
    }
    try {
        // 라이브 파서로 정식 폴더명([id] 작품명) 계산 → 모든 회차가 같은 폴더(외전 포함)로 분류됨.
        const folder = await computeSeriesFolderLive();
        const r = await expandSeriesToJobs(cfg, location.href, folder, items);
        tokiAlert(`📤 ${r.count}개 회차를 원격 풀에 투입했습니다.\n폴더: ${r.folder || '(자동)'}\n추가 ${r.added} · 중복 ${r.skipped} 제외\n각 클라이언트(프로필)가 나눠서 다운로드합니다.`);
    } catch (e) {
        tokiAlert('투입 실패: ' + (e && e.message ? e.message : e));
    }
}

/** 원격 제어 설정 모달 (dsx-modal 스타일 재사용) */
export function openRemoteModal() {
    const existing = document.getElementById('dsx-remote-modal');
    if (existing) existing.remove();

    const cfg = getRemoteConfig();
    const overlay = document.createElement('div');
    overlay.id = 'dsx-remote-modal';
    overlay.className = 'dsx-modal-overlay';
    overlay.innerHTML = `
        <div class="dsx-modal dsx-modal-main">
            <div class="dsx-modal-header dsx-modal-header-borderless">
                <div class="dsx-modal-title dsx-text-lg">🌐 원격 제어 설정</div>
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label" style="display:flex;align-items:center;gap:8px;">
                    <input type="checkbox" id="dsx-rm-enabled" ${cfg.enabled ? 'checked' : ''}>
                    원격 제어 활성화 (컨트롤 API 폴링)
                </label>
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label">컨트롤 API 주소</label>
                <input type="text" id="dsx-rm-url" class="dsx-input" placeholder="http://192.168.0.x:8787" value="${(cfg.url || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label">API 토큰</label>
                <input type="password" id="dsx-rm-token" class="dsx-input" placeholder="컨트롤 API 토큰" value="${(cfg.token || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label">폴링 주기 (초)</label>
                <input type="number" id="dsx-rm-poll" class="dsx-input" min="2" max="60" value="${cfg.pollSec}">
            </div>
            <div class="dsx-section-title">멀티-IP 분배 (lease 모드)</div>
            <div class="dsx-control-group">
                <label class="dsx-label">클라이언트 ID (비우면 단일 모드)</label>
                <input type="text" id="dsx-rm-client" class="dsx-input" placeholder="예: A-direct / B-vpn" value="${(cfg.clientId || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label">동시 보유 작업 수 (lease max, 기본 2)</label>
                <input type="number" id="dsx-rm-leasemax" class="dsx-input" min="1" max="20" value="${cfg.leaseMax}">
            </div>
            <div class="dsx-modal-footer dsx-btn-group-row dsx-mt-32">
                <button id="dsx-rm-cancel" class="dsx-btn-action dsx-btn-secondary">취소</button>
                <button id="dsx-rm-save" class="dsx-btn-action">저장 (새로고침)</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const cancel = overlay.querySelector('#dsx-rm-cancel');
    if (cancel) cancel.onclick = () => overlay.remove();

    overlay.querySelector('#dsx-rm-save').onclick = () => {
        _sv(CFG_REMOTE_ENABLED, overlay.querySelector('#dsx-rm-enabled').checked ? '1' : '0');
        _sv(CFG_REMOTE_API_URL, overlay.querySelector('#dsx-rm-url').value.trim());
        _sv(CFG_REMOTE_API_TOKEN, overlay.querySelector('#dsx-rm-token').value.trim());
        _sv(CFG_REMOTE_POLL_SEC, String(parseInt(overlay.querySelector('#dsx-rm-poll').value, 10) || 5));
        _sv(CFG_REMOTE_CLIENT_ID, overlay.querySelector('#dsx-rm-client').value.trim());
        _sv(CFG_REMOTE_LEASE_MAX, String(parseInt(overlay.querySelector('#dsx-rm-leasemax').value, 10) || 2));
        _sv(K_LAST_SEQ, '-1'); // 설정 변경 시 기준선 재설정
        overlay.remove();
        try { location.reload(); } catch {}
    };
}
