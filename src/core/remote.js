/**
 * 원격 제어 폴링 어댑터 (멀티-IP lease ↔ upstream v1.21.0 queue API)
 *
 * 컨트롤 API 서버(server/control-api.js)를 주기적으로 폴링해서:
 *   - lease 모드(clientId 설정): /lease 로 unit 을 원자 임대 → addEpisodesToQueue 로 로컬 큐에 주입.
 *     upstream 의 이벤트 기반 스케줄러(initQueueScheduler)가 큐 변동을 감지해 워커 팝업을 자동 기동.
 *     큐 item 의 status('completed'|'failed') 를 보고 /complete 로 결과 보고(중복 없는 회차 분배).
 *   - /progress 로 clientId·외부IP·진행률·보유 unit heartbeat(서버가 lease TTL 갱신).
 *   - 작품 자동 펼침(/jobs)·캡차 격리(/captcha) 처리.
 *
 * upstream 연동 요지(이전 feature 브랜치 대비 변경점):
 *   - 우리 전용 큐 함수(addLeasedUnits/runLeaseQueue/startQueue/stopQueue/isRunning/pathKey/saveQueue)
 *     → upstream queue.js API(addEpisodesToQueue/getQueue/updateQueueItem/initQueueScheduler/
 *        setQueuePaused/getQueuePaused) 로 교체.
 *   - 큐 item 상태값은 upstream 컨벤션('completed'/'failed') 사용(이전 'done'/'error' 아님).
 *   - 큐 구동은 reload/navigation 이 아니라 GM_addValueChangeListener 이벤트 스케줄러가 담당.
 *     remote 는 큐에 주입만 하고 스케줄러를 1회 init 한다(runScheduler 직접 호출 금지).
 *   - 서버 unit.id 는 episodes 커스텀 필드 unitId 로 동봉 → 완료 시 그걸로 /complete(큐 item id 와 별개).
 */
import {
    addEpisodesToQueue,
    getQueue,
    removeQueueItem,
    initQueueScheduler,
    runSchedulerOnce,
    setQueuePaused,
    stopAllWorkers,
    clearQueue,
} from './queue.js';
import { initBatchWorkerController } from './worker-controller.js';
import {
    getRemoteConfig,
    CFG_REMOTE_ENABLED,
    CFG_REMOTE_API_URL,
    CFG_REMOTE_API_TOKEN,
    CFG_REMOTE_POLL_SEC,
    CFG_REMOTE_CLIENT_ID,
    CFG_REMOTE_LEASE_MAX,
} from './config.js';
import { LogBox } from './ui.js';
import { ParserFactory } from './parsers/ParserFactory.js';
import { getCommonPrefix } from './utils.js';

const K_DONE_EXP = 'TOKI_REMOTE_DONE_EXPANSIONS'; // 이미 처리한 expand 요청 id (중복 펼침 방지)

let _timer = null;
let _started = false;
let _schedulerInited = false;
let _lastClearSeq = null; // 서버 풀 비우기(/jobs/clear) 신호 추적 — 첫 연결은 동기화만, 이후 증가 감지 시 정리
let _lastProgress = null;
let _externalIp = '';   // 외부 IP(식별/검증용, 1회 조회 후 캐시)
let _ipQueried = false;
let _lastLogSeq = 0;    // 마지막으로 서버에 전송한 LogBox seq(로그 증분 전송 커서)
let _pollInFlight = false;
let _pollQueued = false;
let _lastKickAt = 0;
let _lastPendingWakeAt = 0;
const POLL_KICK_THROTTLE_MS = 750;
const PENDING_WAKE_THROTTLE_MS = 10000;

/** upstream 큐 status('completed'/'failed') 종결 판정. */
function _isFinished(status) { return status === 'completed' || status === 'failed'; }

/** 가벼운 알림(원격 컨텍스트엔 전용 모달이 없어 window.alert 폴백). */
function _notify(msg) { try { if (typeof alert === 'function') alert(msg); } catch (e) {} }

/** 현재 유저스크립트 버전(GM_info) — 대시보드 클라 카드에 표시해 미업데이트 프로필을 즉시 식별. */
function _scriptVersion() {
    try { return (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || ''; }
    catch (e) { return ''; }
}

/** LogBox 의 새 로그(마지막 전송 이후)를 증분 수집 — heartbeat 에 동봉해 대시보드로 스트림한다. */
function _collectLogsSince() {
    try {
        const lb = LogBox.getInstance();
        const all = (lb && lb.logs) || [];
        const out = all
            .filter((l) => l.seq > _lastLogSeq)
            .map((l) => ({ seq: l.seq, time: l.time, type: l.type || 'normal', msg: (l.context ? `[${l.context}] ` : '') + l.msg }));
        if (out.length) _lastLogSeq = out[out.length - 1].seq;
        return out;
    } catch (e) { return []; }
}

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
        // seriesUrl 에 맞는 룰로 파서 생성(현재 클라가 다른 카테고리 페이지에 있어도 정확).
        //   ⚠️ getParser()(현재 location) 를 쓰면 만화 페이지 클라가 소설을 펼칠 때 만화 셀렉터로
        //   소설 목록을 파싱해 실패 → num/title/cover 누락(문자열 폴백). getParserForUrl 로 해결.
        const parser = await ParserFactory.getParserForUrl(seriesUrl);
        const listCfg = parser && parser.rule && parser.rule.list;
        if (!listCfg || !listCfg.container || !listCfg.item || typeof parser.parseListItem !== 'function') return null;
        const container = doc.querySelector(listCfg.container);
        if (!container) return null;
        const els = Array.from(container.querySelectorAll(listCfg.item));
        if (!els.length) return null;
        let origin = '';
        try { origin = new URL(seriesUrl).origin; } catch (e) {}
        // [표지] 시리즈 목록 doc 에서 표지 URL 1회 추출(rule.meta.thumb) → 모든 회차 unit 에 동봉.
        //   각 회차 EPUB 에 cover.<ext> 로 삽입돼 Kavita 가 첫 회차 표지를 시리즈 대표로 사용.
        let cover = '';
        try {
            const thumbCfg = parser.rule && parser.rule.meta && parser.rule.meta.thumb;
            const t = (thumbCfg && typeof parser._extractValue === 'function') ? parser._extractValue(doc, thumbCfg) : '';
            if (t) cover = new URL(t, seriesUrl).href;
        } catch (e) {}
        // [시리즈 메타] 작가/소개/상태/태그를 시리즈 doc 에서 1회 추출 → 모든 회차 unit 에 동봉.
        //   getSeriesMetadata()는 전역 document 기반이라 부모(만화) 페이지를 보지만, doc 인자로 정확히 추출.
        let seriesMeta = null;
        try { seriesMeta = (typeof parser.getSeriesMetadata === 'function') ? parser.getSeriesMetadata(doc) : null; } catch (e) {}
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
            out.push({ url, num: it.num || '', label: it.title || '', cover, meta: seriesMeta });
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

/**
 * lease unit → upstream 큐 episode 객체로 변환.
 *   unit.url 에 매칭되는 룰로 파서를 만들어 category/viewer 를 정확히 채운다(부모 페이지 카테고리 무관).
 *   upstream worker 는 episode.category 로 소설/만화 분기(novel→epub, 그 외→cbz)하므로 정확해야 한다.
 *   서버 unit.id 는 unitId 커스텀 필드로 보존 → 완료 시 /complete 매핑(큐 item id 와 별개).
 */
async function unitToEpisode(u) {
    if (!u || !u.url) return null;
    let rule = {};
    try {
        const parser = await ParserFactory.getParserForUrl(u.url);
        rule = (parser && parser.rule) || {};
    } catch (e) {}
    const cat = rule.category || 'Webtoon';
    const isNovel = /novel/i.test(cat);
    let origin = '';
    try { origin = new URL(u.url).origin; } catch (e) {}
    return {
        episodeNum: u.num || '',
        url: u.url,
        title: u.label || '',
        rootFolder: u.series || '',
        category: cat,
        novelFormat: isNovel ? 'epub' : 'cbz',
        matchedRule: rule,
        protocolDomain: origin,
        viewerCfg: rule.viewer || {},
        destination: 'native',
        // 멀티-IP 메타(lease 풀 식별/표지/시리즈 메타 + 서버 unit 매핑 키).
        series: u.series,
        cover: u.cover,
        meta: u.meta,
        unitId: u.id,
    };
}

/** 폴링 디스패처 — clientId 설정 시 lease 모드, 아니면 레거시(heartbeat 미러)만. */
async function poll() {
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;
    if (cfg.clientId) return pollLease(cfg);
    return pollLegacy(cfg);
}

function scheduleNextPoll(delayMs, reason = 'timer') {
    if (!_started) return;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
    _timer = setTimeout(() => {
        _timer = null;
        runPollCycle(reason);
    }, Math.max(0, delayMs || 0));
}

async function runPollCycle(reason = 'timer') {
    if (!_started) return;
    if (_pollInFlight) {
        _pollQueued = true;
        return;
    }

    _pollInFlight = true;
    try {
        await poll();
    } catch (e) {
        const m = e && e.message ? e.message : e;
        try { console.warn('[TokiSync-Remote] poll cycle 실패:', m); } catch {}
    } finally {
        _pollInFlight = false;
        const cfg = getRemoteConfig();
        if (_pollQueued) {
            _pollQueued = false;
            scheduleNextPoll(0, 'queued');
        } else if (_started && cfg.enabled && cfg.url) {
            scheduleNextPoll(Math.max(2, cfg.pollSec || 5) * 1000, reason);
        }
    }
}

function kickPoll(reason = 'event', force = false) {
    if (!_started) return;
    const now = Date.now();
    if (!force && now - _lastKickAt < POLL_KICK_THROTTLE_MS) return;
    _lastKickAt = now;
    if (_timer) {
        clearTimeout(_timer);
        _timer = null;
    }
    runPollCycle(reason);
}

/**
 * 레거시 단일 클라 모드(하위호환) — upstream 큐엔 명령형 addUrls 가 없으므로 명령 적용은 하지 않고
 *   로컬 큐 상태만 /progress 로 미러 보고한다(대시보드 표시용). 멀티-IP(lease) 가 메인 경로.
 */
async function pollLegacy(cfg) {
    try {
        await gmRequest({
            method: 'POST',
            url: `${base(cfg.url)}/progress`,
            token: cfg.token,
            data: { queue: getQueue(), running: getQueue().some((i) => i.status === 'processing'), progress: _lastProgress },
        });
    } catch (e) {
        const m = e && e.message ? e.message : '';
        if (/^HTTP [45]/.test(m)) {
            try { console.warn('[TokiSync-Remote] progress 보고 실패:', m); } catch {}
        }
    }
}

/**
 * 멀티-IP lease 모드 — 작업 분배(work-stealing). upstream 큐 API 연동.
 *  ① 완료(completed/failed)된 unit을 /complete로 보고 → reported 플래그로 1회만 보고.
 *  ② 보유(pending/processing) unit이 부족하면 /lease로 보충 → addEpisodesToQueue 로 주입
 *     (이벤트 스케줄러가 큐 변동을 감지해 워커를 자동 기동).
 *  ③ /progress로 clientId·외부IP·진행률·보유 unit heartbeat(서버가 lease TTL 갱신).
 *  ④ paused 동기화 + 작품 자동 펼침 처리.
 * 페이지 내비게이션을 거쳐도 unitId가 GM 큐에 영속되므로 완료 매핑/재투입이 안전하게 이어진다.
 */
async function pollLease(cfg) {
    // 이전 버전에서 /complete 보고 후 남겨둔 terminal lease 항목은 재lease 중복 판단을 방해하므로 청소한다.
    {
        const reportedTerminal = getQueue().filter((i) => i.unitId && _isFinished(i.status) && i.reported);
        for (const item of reportedTerminal) {
            try { removeQueueItem(item.id); } catch (e) {}
        }
    }

    // ① 완료 보고 — unitId 가 붙은 큐 항목 중 종결(completed/failed) & 미보고분 수집.
    //    서버 응답을 받은 terminal 항목은 로컬 큐에서 제거해 이후 재lease가 pending으로 들어오게 한다.
    {
        const q = getQueue();
        const finished = q.filter((i) => i.unitId && _isFinished(i.status) && !i.reported);
        if (finished.length) {
            const results = finished.map((i) => ({ id: i.unitId, ok: i.status === 'completed' }));
            try {
                await gmRequest({
                    method: 'POST',
                    url: `${base(cfg.url)}/complete`,
                    token: cfg.token,
                    data: { clientId: cfg.clientId, results },
                });
                finished.forEach((i) => removeQueueItem(i.id));
            } catch (e) {
                // 실패 시 로컬 큐에 유지 → 다음 주기 재시도(at-least-once 보고).
            }
        }
    }

    // ② 임대 보충 — 보유(pending/processing) lease unit 수가 목표(leaseMax) 미만이면 부족분만큼 요청.
    {
        const q = getQueue();
        const held = q.filter((i) => i.unitId && (i.status === 'pending' || i.status === 'processing')).length;
        if (held < cfg.leaseMax) {
            const want = cfg.leaseMax - held;
            try {
                const res = await gmRequest({
                    method: 'GET',
                    url: `${base(cfg.url)}/lease?clientId=${encodeURIComponent(cfg.clientId)}&max=${want}`,
                    token: cfg.token,
                });
                const units = Array.isArray(res.units) ? res.units : [];
                if (units.length) {
                    const episodes = (await Promise.all(units.map((u) => unitToEpisode(u)))).filter(Boolean);
                    if (episodes.length) {
                        // novelTitle(=id 해시 시드)은 회차별 폴더명(rootFolder). 같은 시리즈는 동일 시드.
                        addEpisodesToQueue(episodes, episodes[0].rootFolder || '');
                    }
                }
            } catch (e) {
                const m = e && e.message ? e.message : '';
                if (/^HTTP [45]/.test(m)) {
                    try { console.warn('[TokiSync-Remote] lease 실패:', m); } catch {}
                }
            }
        }
    }

    // ③ heartbeat — clientId/외부IP/진행률/보유 unit 보고(서버가 해당 클라의 모든 leased unit TTL 갱신).
    let hbRes = null;
    {
        const cur = getQueue();
        const current = cur.filter((i) => i.unitId && (i.status === 'pending' || i.status === 'processing')).map((i) => i.unitId);
        const processing = cur.filter((i) => i.unitId && i.status === 'processing').map((i) => i.unitId);
        const queueSummary = cur.map((i) => ({
            id: i.id,
            status: i.status,
            episodeNum: i.episodeNum,
            episodeTitle: i.episodeTitle,
            unitId: i.unitId,
            progressPercent: i.progressPercent,
            stage: i.stage || '',
            startedAt: i.startedAt || 0,
            lastProgressAt: i.lastProgressAt || 0,
            retryCount: i.retryCount || 0,
            errorMsg: i.errorMsg || ''
        }));
        try {
            hbRes = await gmRequest({
                method: 'POST',
                url: `${base(cfg.url)}/progress`,
                token: cfg.token,
                data: {
                    clientId: cfg.clientId,
                    label: cfg.clientId,
                    ip: await ensureExternalIp(),
                    queue: queueSummary,
                    running: processing.length > 0,
                    progress: _lastProgress,
                    current,
                    logs: _collectLogsSince(), // 새 로그 증분 동봉(대시보드 실시간 로그 패널용)
                    version: _scriptVersion(), // 유저스크립트 버전(대시보드 클라 카드 표시 — 미업데이트 프로필 진단)
                },
            });
        } catch (e) {
            const m = e && e.message ? e.message : '';
            if (/^HTTP [45]/.test(m)) {
                try { console.warn('[TokiSync-Remote] heartbeat 실패:', m); } catch {}
            }
        }
    }

    // ③-b clear 동기화 — 서버 풀 비우기(/jobs/clear)를 로컬 큐/워커에도 반영.
    //    서버 clearSeq 가 증가하면(새 clear) 활성 워커 팝업을 닫고(stopAllWorkers) 로컬 큐를 완전히 비운다(clearQueue).
    //    이게 없으면 서버 풀만 비고 클라 로컬 큐가 남아 워커가 계속 돈다.
    const _srvClearSeq = (hbRes && Number(hbRes.clearSeq)) || 0;
    if (_lastClearSeq === null) {
        _lastClearSeq = _srvClearSeq; // 첫 연결: 기준값만 동기화(기존 clear 재실행 방지 — 방금 투입한 큐 보호)
    } else if (_srvClearSeq > _lastClearSeq) {
        _lastClearSeq = _srvClearSeq;
        try {
            stopAllWorkers();   // 활성 팝업 닫기 + pending/processing → failed 마킹
            clearQueue();       // 로컬 큐 완전 비우기(failed 잔존도 제거)
            LogBox.getInstance().log('🗑️ 서버 풀 비우기 감지 → 로컬 큐/워커 정리', 'warn', 'Remote');
        } catch (e) {}
    }

    // ③-c lease 소유권 재동기화 — 서버가 TTL 만료/재시작 후 unit을 다른 클라에 재임대한 경우,
    //      기존 클라 로컬 큐의 stale pending/processing을 제거해 대시보드 current/running 불일치와 중복 수집을 막는다.
    reconcileOwnedLeases(hbRes && hbRes.ownedLeaseIds);

    // ④ paused 동기화 — 서버 정지 상태를 upstream 큐 일시정지(setQueuePaused)에 반영.
    //    스케줄러는 getQueuePaused() 를 보고 새 워커 기동을 보류한다. 정지면 자동 펼침도 생략.
    setQueuePaused(!!(hbRes && hbRes.paused));
    if (hbRes && hbRes.paused) return;

    // 서버가 정지였다가 재개된 경우, 로컬 큐에는 이미 pending lease가 있지만
    // GM storage 변경 이벤트가 새로 발생하지 않아 스케줄러가 잠든 채 남을 수 있다.
    // pending-only heartbeat에서는 즉시 1회 + 짧은 지연 1회로 깨워 마지막 보유 lease도 실행되게 한다.
    try {
        const q = getQueue();
        const pendingLeases = q.filter((i) => i.unitId && i.status === 'pending');
        const hasProcessingLease = q.some((i) => i.unitId && i.status === 'processing');
        if (pendingLeases.length && !hasProcessingLease) {
            const now = Date.now();
            if (now - _lastPendingWakeAt > PENDING_WAKE_THROTTLE_MS) {
                _lastPendingWakeAt = now;
                LogBox.getInstance().log(`⏯️ pending lease ${pendingLeases.length}건 감지 → 스케줄러 재가동`, 'warn', 'Remote');
            }
            runSchedulerOnce();
            setTimeout(() => {
                try { runSchedulerOnce(); } catch (e) {}
            }, 1500);
        }
    } catch (e) {}

    // ⑤ 작품 자동 펼침 — heartbeat 응답의 expand 요청을 처리(Cloudflare 통과한 이 브라우저가
    //    회차 목록을 받아 /jobs 로 투입). 멱등이라 다른 클라가 동시에 처리해도 중복은 흡수된다.
    if (hbRes && Array.isArray(hbRes.expansions) && hbRes.expansions.length) {
        try { await processExpansions(cfg, hbRes.expansions); } catch (e) {}
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

function reconcileOwnedLeases(ownedLeaseIds) {
    if (!Array.isArray(ownedLeaseIds)) return 0;
    const owned = new Set(ownedLeaseIds);
    const q = getQueue();
    const lost = q.filter((i) =>
        i && i.unitId &&
        (i.status === 'pending' || i.status === 'processing') &&
        !owned.has(i.unitId)
    );
    for (const item of lost) {
        try { removeQueueItem(item.id); } catch (e) {}
    }
    if (lost.length) {
        try {
            LogBox.getInstance().log(`↩️ 서버 lease 소유권 상실 감지 → 로컬 작업 ${lost.length}건 제거`, 'warn', 'Remote');
        } catch (e) {}
    }
    return lost.length;
}

/** 큐 폴링 시작 (top window 한정) */
export function startRemoteSync() {
    if (_started) return;
    if (window.self !== window.top) return;
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;
    _started = true;

    // upstream 이벤트 스케줄러 + 배치 IPC 라우터 1회 init. 중복 init 가드.
    //   ⚠️ initBatchWorkerController 필수: 워커 READY → START_EXTRACTION 주입 라우터.
    //   이게 없으면 lease 워커 팝업이 떠도 지시를 못 받아 멈춘다(스크롤/추출 미진행).
    //   먼저 라우터를 켠 뒤 스케줄러(팝업 기동)를 돌려야 READY 를 놓치지 않는다.
    if (!_schedulerInited) {
        _schedulerInited = true;
        try { initBatchWorkerController(); } catch (e) {}
        try { initQueueScheduler(); } catch (e) {}
    }

    window.addEventListener('toki:captcha', onCaptcha);
    window.addEventListener('toki:progress', onProgress);
    window.addEventListener('toki:remote-kick', (ev) => {
        const reason = (ev && ev.detail && ev.detail.reason) || 'event';
        kickPoll(reason, reason === 'worker-finished');
    });
    window.addEventListener('focus', () => kickPoll('focus'));
    window.addEventListener('pageshow', () => kickPoll('pageshow'));
    window.addEventListener('online', () => kickPoll('online', true));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') kickPoll('visible', true);
    });
    // 백업: 팝업이 top까지 보낸 캡차 postMessage도 포착
    window.addEventListener('message', (ev) => {
        if (ev && ev.data && ev.data.type === 'TOKI_CAPTCHA_DETECTED') onCaptcha();
    });

    kickPoll('start', true);
    try { console.log(`[TokiSync-Remote] polling ${base(cfg.url)} every ${cfg.pollSec}s (+ event wake)`); } catch {}
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
        _notify('먼저 🌐 원격 제어 설정에서 컨트롤 API 주소/토큰을 설정하고 활성화하세요.');
        return;
    }
    // 라이브 파서로 회차 목록 추출 — 각 회차의 권위 번호(num)/제목(title)을 함께 가져온다
    //   (외전·소수회차도 정확히 명명). 파서 실패 시 generic anchor 추출로 폴백.
    let items = [];
    try {
        const parser = await ParserFactory.getParser();
        // [표지] 라이브 파서로 표지 URL 1회 추출 → 모든 회차 unit 에 동봉(Kavita cover.jpg).
        let cover = '';
        try { cover = (parser && typeof parser.getThumbnailUrl === 'function' && parser.getThumbnailUrl()) || ''; } catch (e) {}
        // [시리즈 메타] 라이브 파서로 작가/소개/상태/태그 1회 추출(현재 작품 페이지) → 모든 회차 unit 에 동봉.
        let seriesMeta = null;
        try { seriesMeta = (parser && typeof parser.getSeriesMetadata === 'function') ? parser.getSeriesMetadata() : null; } catch (e) {}
        const list = (parser && parser.getListItems) ? (await parser.getListItems()) || [] : [];
        if (list.length && parser.parseListItem) {
            items = list.map((li) => { const it = parser.parseListItem(li); return { url: it.src, num: it.num, label: it.title, cover, meta: seriesMeta }; })
                        .filter((u) => u.url && /^https?:\/\//i.test(u.url));
        }
    } catch (e) {}
    if (!items.length) items = extractChapterUrls(document, location.href); // 폴백(문자열 url들)
    if (!items.length) {
        _notify('이 페이지에서 회차 목록을 찾지 못했습니다.\n작품 메인(회차 목록) 페이지에서 실행하세요.');
        return;
    }
    try {
        // 라이브 파서로 정식 폴더명([id] 작품명) 계산 → 모든 회차가 같은 폴더(외전 포함)로 분류됨.
        const folder = await computeSeriesFolderLive();
        const r = await expandSeriesToJobs(cfg, location.href, folder, items);
        _notify(`📤 ${r.count}개 회차를 원격 풀에 투입했습니다.\n폴더: ${r.folder || '(자동)'}\n추가 ${r.added} · 중복 ${r.skipped} 제외\n각 클라이언트(프로필)가 나눠서 다운로드합니다.`);
    } catch (e) {
        _notify('투입 실패: ' + (e && e.message ? e.message : e));
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
        overlay.remove();
        try { location.reload(); } catch {}
    };
}
