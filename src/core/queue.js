/**
 * 다중 시리즈 자동 큐 (cross-page, GM 영속화)
 *
 * 동작: 시리즈 URL들을 큐에 넣고 "시작" → 스크립트가 각 시리즈 페이지로 자동 이동하며
 * 전체 다운로드 → 완료되면 다음 시리즈로. 새로고침/페이지 전환을 거쳐도 GM 저장소로 이어받음.
 *
 * - 큐 상태: GM "TOKI_QUEUE" = [{url, title, status:'pending'|'done'|'error', error?}]
 * - 실행 플래그: GM "TOKI_QUEUE_RUNNING" = "1" | "0"
 * - 다운로드는 호출측이 주입(tokiDownload) — 현재 저장된 정책(native/drive 등) 사용
 */

import { LogBox, Notifier, tokiAlert } from './ui.js';

const K_QUEUE = 'TOKI_QUEUE';
const K_RUNNING = 'TOKI_QUEUE_RUNNING';

let _ranThisLoad = false; // 한 페이지 로드에서 큐 처리 1회 보장

/** 원격 대시보드용 진행률 이벤트 방출(remote.js가 수신) */
function _emitProgress(detail) {
    try { window.dispatchEvent(new CustomEvent('toki:progress', { detail })); } catch {}
}

function _get(key, def) {
    try { return typeof GM_getValue !== 'undefined' ? GM_getValue(key, def) : def; }
    catch { return def; }
}
function _set(key, val) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(key, val); } catch {}
}

export function getQueue() {
    try { return JSON.parse(_get(K_QUEUE, '[]')) || []; } catch { return []; }
}
export function saveQueue(arr) {
    _set(K_QUEUE, JSON.stringify(Array.isArray(arr) ? arr : []));
}
export function isRunning() { return _get(K_RUNNING, '0') === '1'; }
export function setRunning(b) { _set(K_RUNNING, b ? '1' : '0'); }

/** 비교용 URL 정규화 — pathname만 사용(도메인 미러 변동에 강건) */
export function pathKey(u) {
    try { return new URL(u, location.href).pathname.replace(/\/+$/, ''); }
    catch { return (u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, ''); }
}

/** 줄/공백 구분 URL 문자열 → 큐 항목 추가(중복 제거) */
export function addUrls(text) {
    const urls = (text || '')
        .split(/[\s\n]+/).map(s => s.trim())
        .filter(s => /^https?:\/\//i.test(s));
    if (urls.length === 0) return 0;
    const q = getQueue();
    const existing = new Set(q.map(i => pathKey(i.url)));
    let added = 0;
    for (const url of urls) {
        const k = pathKey(url);
        if (existing.has(k)) continue;
        existing.add(k);
        q.push({ url, title: '', status: 'pending' });
        added++;
    }
    saveQueue(q);
    return added;
}

/**
 * 원격 lease로 임대받은 unit들을 로컬 큐에 주입(unitId 부착, pathKey 기준 중복 제거).
 * unitId가 있으면 remote.js가 완료 시 서버에 `/complete`로 매핑 보고한다.
 * @param {Array<{id:string,url:string,label?:string}>} units
 * @returns {number} 실제 추가된 수
 */
export function addLeasedUnits(units) {
    if (!Array.isArray(units) || units.length === 0) return 0;
    const q = getQueue();
    // unitId는 서버 권위 키 → 같은 unit 재주입 방지. pathKey 중복은 "아직 처리 안 끝난"(pending)
    // 항목에 대해서만 차단한다(done/error 잔존 항목과 충돌해 재임대분을 영영 떨구는 lease-leak 방지).
    const seenIds = new Set(q.filter(i => i.unitId).map(i => i.unitId));
    const activeKeys = new Set(q.filter(i => i.status === 'pending').map(i => pathKey(i.url)));
    let added = 0;
    for (const u of units) {
        if (!u || !u.url || !/^https?:\/\//i.test(u.url)) continue;
        if (u.id && seenIds.has(u.id)) continue;          // 동일 unit 이미 보유
        const k = pathKey(u.url);
        if (activeKeys.has(k)) continue;                  // 미완 항목과 URL 충돌 → 중복 다운로드 방지
        seenIds.add(u.id);
        activeKeys.add(k);
        // series=정식 폴더명([id] 작품명), num/title=시리즈 목록의 권위 회차번호/제목. 다운로드 시 사용.
        q.push({ url: u.url, title: u.label || '', status: 'pending', unitId: u.id, series: u.series || '', num: u.num || '' });
        added++;
    }
    if (added) saveQueue(q);
    return added;
}

export function clearQueue() { saveQueue([]); setRunning(false); }

/** 큐 시작 — 첫 대기 항목으로 이동(현재 페이지가 그 항목이면 자동 처리에 위임).
 *   ⚠️ lease unit(회차, unitId 있음)은 부모 탭을 회차로 이동시키지 않는다 → maybeRunQueue 의 in-place 경로에 위임.
 *   단일/벌크(시리즈 URL) 모드만 기존 navigation 동작 유지. */
export function startQueue() {
    const q = getQueue();
    const pending = q.filter(i => i.status === 'pending');
    if (pending.length === 0) { tokiAlert('큐에 대기 중인 항목이 없습니다.'); return; }
    setRunning(true);
    const first = pending[0];
    // lease 모드: 부모 navigation 금지. 현재 페이지에 고정한 채 새로고침으로 maybeRunQueue in-place 처리 진입.
    //   (이미 현재 페이지에서 호출됐다면 maybeRunQueue 가 같은 로드에서 곧장 처리 — reload 불필요할 수 있으나,
    //    startQueue 는 보통 다른 컨텍스트(메뉴/리모트)에서 호출되므로 안전하게 reload 로 진입 보장.)
    if (first.unitId) {
        location.reload();
        return;
    }
    if (pathKey(first.url) === pathKey(location.href)) {
        // 이미 첫 항목 페이지 → 새로고침으로 자동 처리 진입
        location.reload();
    } else {
        location.href = first.url;
    }
}

export function stopQueue() {
    setRunning(false);
    LogBox.getInstance().log('⏸️ 큐 정지됨', 'Queue');
}

/**
 * 매 페이지 로드 시 호출(top window 한정). 큐가 실행 중이면:
 *  - 현재 페이지가 대기 항목이면 다운로드 → 완료 표시 → 다음 항목으로 이동
 *  - 아니면 첫 대기 항목으로 이동
 * @param {() => Promise<any>} downloadFn 현재 시리즈 전체 다운로드(예: () => tokiDownload(undefined, policy))
 */
export async function maybeRunQueue(downloadFn) {
    if (_ranThisLoad) return;
    if (window.self !== window.top) return;       // iframe 안에서는 동작 금지
    if (!isRunning()) return;
    _ranThisLoad = true;

    const logger = LogBox.getInstance();
    let q = getQueue();
    let pending = q.filter(i => i.status === 'pending');
    if (pending.length === 0) {
        setRunning(false);
        logger.success('✅ 큐 전체 완료', 'Queue');
        Notifier.notify('TokiSync', '다운로드 큐 전체 완료!');
        return;
    }

    // [멀티-IP lease 분기] pending 에 lease unit(unitId)이 있으면 부모 탭은 회차로 navigate 하지 않는다.
    //   부모는 현재 페이지(시리즈 목록 등 같은 origin)에 고정한 채, 워커 팝업만 회차 URL 들을 순회하며 본문+메타 회신.
    //   → 메타 정확도(불안정한 회차페이지 재추출 제거) + 안티탐지(컨트롤러가 회차 probe 에 노출 안 됨).
    //   단일/벌크(시리즈 URL, unitId 없음)는 아래 기존 navigation 경로를 그대로 탄다(회귀 금지).
    if (pending.some(i => i.unitId)) {
        await runLeaseQueue(downloadFn);
        return;
    }

    const curKey = pathKey(location.href);
    const active = q.find(i => i.status === 'pending' && pathKey(i.url) === curKey);

    if (!active) {
        // 현재 페이지가 큐 항목이 아님 → 첫 대기 항목으로 이동
        const next = pending[0];
        logger.log(`📋 큐: 다음 시리즈로 이동 (${next.url})`, 'Queue');
        setTimeout(() => { location.href = next.url; }, 5000);
        return;
    }

    // 현재 페이지 = 활성 항목 → 다운로드 실행
    const idx = q.indexOf(active);
    const pos = q.filter(i => i.status !== 'pending').length + 1;
    logger.show();
    logger.log(`📋 큐 처리 ${pos}/${q.length}: ${location.href}`, 'Queue');
    _emitProgress({ phase: '다운로드 중', pos, total: q.length, url: location.href });
    try {
        await downloadFn(active); // active 항목 전달 → lease unit(회차)이면 단일 회차 다운로드
        active.status = 'done';
        active.title = document.title || active.title;
        logger.success(`📋 큐 항목 완료 (${pos}/${q.length})`, 'Queue');
        _emitProgress({ phase: '항목 완료', pos, total: q.length, url: location.href });
    } catch (e) {
        active.status = 'error';
        active.error = e && e.message ? e.message : String(e);
        logger.error(`📋 큐 항목 실패: ${active.error}`, 'Queue');
        _emitProgress({ phase: '항목 실패', pos, total: q.length, url: location.href, error: active.error });
    }
    // 저장(인덱스 보존)
    q[idx] = active;
    saveQueue(q);

    // 다음 대기 항목으로
    const next = getQueue().find(i => i.status === 'pending');
    if (next) {
        logger.log('📋 5초 후 다음 시리즈로 이동...', 'Queue');
        setTimeout(() => { location.href = next.url; }, 5000);
    } else {
        setRunning(false);
        logger.success('✅ 큐 전체 완료', 'Queue');
        Notifier.notify('TokiSync', '다운로드 큐 전체 완료!');
    }
}

/**
 * [멀티-IP lease 전용] 부모 탭을 고정한 채 현재 보유한 pending lease unit 들을 순차 처리.
 *   각 unit 은 downloadFn(item) 으로 다운로드 — downloadSingleEpisode 가 unit.url(회차)로 워커 팝업만 띄워
 *   본문을 수집하고, 메타는 unit 의 권위값(series/num/title)을 그대로 쓴다. 부모는 회차로 navigate 하지 않는다.
 *   완료/실패는 GM 큐에 마킹(remote.js 가 /complete 보고 후 제거) — navigation 경로의 마킹 규칙과 동일.
 *   이 호출은 "현재 스냅샷의 lease unit"만 처리하고 반환한다. 다음 배치는 remote.js 의 폴링(lease 보충 + reload)이 가져온다.
 * @param {(item:any)=>Promise<any>} downloadFn 큐 항목 1개를 받아 다운로드(예: (item)=> item.unitId ? downloadSingleEpisode(...) : ...)
 */
export async function runLeaseQueue(downloadFn) {
    const logger = LogBox.getInstance();
    logger.show();

    // 이번 호출에서 처리할 대상: 현재 pending 상태의 lease unit 들의 unitId 스냅샷(처리 중 큐 변동에 견고).
    const targetIds = getQueue()
        .filter(i => i.unitId && i.status === 'pending')
        .map(i => i.unitId);
    if (targetIds.length === 0) return;

    for (const unitId of targetIds) {
        // 매 반복마다 최신 큐를 읽어 해당 unit 의 현재 상태를 확인(remote.js 가 동시 갱신할 수 있음).
        let q = getQueue();
        const idx = q.findIndex(i => i.unitId === unitId);
        if (idx < 0) continue;                         // 이미 제거됨(완료 보고 등)
        const item = q[idx];
        if (item.status !== 'pending') continue;       // 이미 처리됨

        // 서버가 전체 정지(paused)를 내리면 remote.js 가 setRunning(false) 처리 → 즉시 중단.
        if (!isRunning()) {
            logger.log('⏸️ lease 처리 중단(정지 감지)', 'Queue');
            return;
        }

        const done = q.filter(i => i.status !== 'pending').length;
        const pos = done + 1;
        logger.log(`📋 lease 처리 ${pos}/${q.length}: ${item.url}`, 'Queue');
        _emitProgress({ phase: '다운로드 중', pos, total: q.length, url: item.url });
        try {
            await downloadFn(item);                    // unit.unitId 존재 → downloadSingleEpisode(회차 1개, 워커 팝업)
            item.status = 'done';
            // ⚠️ 부모는 회차 페이지가 아니므로 document.title 로 덮어쓰지 않는다(목록 제목 오염 방지). 권위 라벨 보존.
            logger.success(`📋 lease 항목 완료 (${pos}/${q.length})`, 'Queue');
            _emitProgress({ phase: '항목 완료', pos, total: q.length, url: item.url });
        } catch (e) {
            item.status = 'error';
            item.error = e && e.message ? e.message : String(e);
            logger.error(`📋 lease 항목 실패: ${item.error}`, 'Queue');
            _emitProgress({ phase: '항목 실패', pos, total: q.length, url: item.url, error: item.error });
        }
        // 인덱스/타 항목 보존을 위해 최신 큐에 다시 반영(처리 중 추가 lease 가 들어왔어도 안전).
        q = getQueue();
        const wi = q.findIndex(i => i.unitId === unitId);
        if (wi >= 0) { q[wi] = item; saveQueue(q); }
    }

    // 이번 배치 처리 완료 → running=false 로 내려 remote.js 폴링이 다음 사이클을 트리거하게 한다.
    //   pollLease 는 !isRunning() && pending 존재 시 startQueue() 호출 → (lease 분기) location.reload() →
    //   부모의 "현재 페이지"(시리즈 목록 등 무해한 origin) 재로드 → 새 maybeRunQueue → runLeaseQueue 다음 배치.
    //   부모는 회차 페이지로 절대 이동하지 않으므로 컨트롤러가 회차 probe 에 노출되지 않는다(안티탐지).
    //   pending 이 더 없으면 다음 maybeRunQueue 진입 시 상단 "pending 0" 분기에서 자연 종료.
    //   (기존 navigation 모드의 "로컬 큐 소진 시 running off → pollLease 재임대/재시작" 의미와 동일.)
    setRunning(false);
    const stillPending = getQueue().some(i => i.status === 'pending');
    if (!stillPending) {
        logger.success('✅ lease 배치 완료(대기 항목 없음)', 'Queue');
    }
}

/** 큐 관리 모달 (자체 포함 DOM, dsx-modal 스타일 재사용) */
export function openQueueModal() {
    const existing = document.getElementById('dsx-queue-modal');
    if (existing) existing.remove();

    const q = getQueue();
    const running = isRunning();
    const rows = q.map((it, i) => {
        const icon = it.status === 'done' ? '✅' : it.status === 'error' ? '❌' : '⏳';
        const label = it.title ? `${it.title}` : it.url;
        return `<div class="dsx-q-row" data-i="${i}">
            <span class="dsx-q-ic">${icon}</span>
            <span class="dsx-q-url" title="${it.url.replace(/"/g, '&quot;')}">${label.replace(/</g, '&lt;')}</span>
            <button class="dsx-q-del" data-i="${i}" title="제거">✕</button>
        </div>`;
    }).join('') || '<div class="dsx-q-empty">큐가 비어 있습니다. 시리즈 URL을 추가하세요.</div>';

    const overlay = document.createElement('div');
    overlay.id = 'dsx-queue-modal';
    overlay.className = 'dsx-modal-overlay';
    overlay.innerHTML = `
        <style>
          #dsx-queue-modal .dsx-q-list{max-height:240px;overflow-y:auto;margin:6px 0;display:flex;flex-direction:column;gap:4px}
          #dsx-queue-modal .dsx-q-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06);font-size:12px}
          #dsx-queue-modal .dsx-q-ic{flex:0 0 auto}
          #dsx-queue-modal .dsx-q-url{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          #dsx-queue-modal .dsx-q-del{flex:0 0 auto;background:transparent;border:none;color:#f87171;cursor:pointer;font-size:13px}
          #dsx-queue-modal .dsx-q-empty{padding:12px;opacity:.6;font-size:12px;text-align:center}
        </style>
        <div class="dsx-modal dsx-modal-main">
            <div class="dsx-modal-header dsx-modal-header-borderless">
                <div class="dsx-modal-title dsx-text-lg">📋 다운로드 큐 ${running ? '<span style="color:#34d399">(실행 중)</span>' : ''}</div>
            </div>
            <div class="dsx-section-title dsx-mt-0">시리즈 URL 추가 (줄바꿈으로 여러 개)</div>
            <div class="dsx-control-group">
                <textarea id="dsx-q-input" class="dsx-textarea" rows="4" placeholder="https://.../comic/12345&#10;https://.../webtoon/67890"></textarea>
            </div>
            <div class="dsx-btn-group-row">
                <button id="dsx-q-add" class="dsx-btn-action dsx-btn-secondary">+ 추가</button>
                <button id="dsx-q-add-cur" class="dsx-btn-action dsx-btn-secondary">+ 현재 페이지</button>
            </div>
            <div class="dsx-section-title">대기열 (${q.length})</div>
            <div id="dsx-q-list" class="dsx-q-list">${rows}</div>
            <div class="dsx-modal-footer dsx-btn-group-row dsx-mt-32">
                <button id="dsx-q-clear" class="dsx-btn-action dsx-btn-secondary">비우기</button>
                ${running
                    ? '<button id="dsx-q-stop" class="dsx-btn-action">⏸️ 정지</button>'
                    : '<button id="dsx-q-start" class="dsx-btn-action">▶️ 시작</button>'}
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const refresh = () => openQueueModal();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.querySelector('#dsx-q-add').onclick = () => {
        const n = addUrls(document.getElementById('dsx-q-input').value);
        tokiAlert(n > 0 ? `${n}개 추가됨` : '추가된 URL이 없습니다 (중복 또는 형식 오류).');
        refresh();
    };
    overlay.querySelector('#dsx-q-add-cur').onclick = () => {
        const n = addUrls(location.href);
        tokiAlert(n > 0 ? '현재 페이지 추가됨' : '이미 큐에 있습니다.');
        refresh();
    };
    overlay.querySelectorAll('.dsx-q-del').forEach(btn => {
        btn.onclick = () => {
            const i = parseInt(btn.dataset.i, 10);
            const arr = getQueue(); arr.splice(i, 1); saveQueue(arr); refresh();
        };
    });
    overlay.querySelector('#dsx-q-clear').onclick = () => { clearQueue(); refresh(); };
    const startBtn = overlay.querySelector('#dsx-q-start');
    if (startBtn) startBtn.onclick = () => { overlay.remove(); startQueue(); };
    const stopBtn = overlay.querySelector('#dsx-q-stop');
    if (stopBtn) stopBtn.onclick = () => { stopQueue(); refresh(); };
}

/** GM 메뉴에 큐 열기 등록 */
export function registerQueueMenu() {
    try {
        if (typeof GM_registerMenuCommand !== 'undefined' && window.self === window.top) {
            GM_registerMenuCommand('📋 다운로드 큐', openQueueModal);
        }
    } catch {}
}
