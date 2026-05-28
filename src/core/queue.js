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
function pathKey(u) {
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

export function clearQueue() { saveQueue([]); setRunning(false); }

/** 큐 시작 — 첫 대기 항목으로 이동(현재 페이지가 그 항목이면 자동 처리에 위임) */
export function startQueue() {
    const q = getQueue();
    const pending = q.filter(i => i.status === 'pending');
    if (pending.length === 0) { tokiAlert('큐에 대기 중인 항목이 없습니다.'); return; }
    setRunning(true);
    const first = pending[0];
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
    try {
        await downloadFn();
        active.status = 'done';
        active.title = document.title || active.title;
        logger.success(`📋 큐 항목 완료 (${pos}/${q.length})`, 'Queue');
    } catch (e) {
        active.status = 'error';
        active.error = e && e.message ? e.message : String(e);
        logger.error(`📋 큐 항목 실패: ${active.error}`, 'Queue');
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

/** 큐 관리 모달 (자체 포함 DOM, toki-modal 스타일 재사용) */
export function openQueueModal() {
    const existing = document.getElementById('toki-queue-modal');
    if (existing) existing.remove();

    const q = getQueue();
    const running = isRunning();
    const rows = q.map((it, i) => {
        const icon = it.status === 'done' ? '✅' : it.status === 'error' ? '❌' : '⏳';
        const label = it.title ? `${it.title}` : it.url;
        return `<div class="toki-q-row" data-i="${i}">
            <span class="toki-q-ic">${icon}</span>
            <span class="toki-q-url" title="${it.url.replace(/"/g, '&quot;')}">${label.replace(/</g, '&lt;')}</span>
            <button class="toki-q-del" data-i="${i}" title="제거">✕</button>
        </div>`;
    }).join('') || '<div class="toki-q-empty">큐가 비어 있습니다. 시리즈 URL을 추가하세요.</div>';

    const overlay = document.createElement('div');
    overlay.id = 'toki-queue-modal';
    overlay.className = 'toki-modal-overlay';
    overlay.innerHTML = `
        <style>
          #toki-queue-modal .toki-q-list{max-height:240px;overflow-y:auto;margin:6px 0;display:flex;flex-direction:column;gap:4px}
          #toki-queue-modal .toki-q-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06);font-size:12px}
          #toki-queue-modal .toki-q-ic{flex:0 0 auto}
          #toki-queue-modal .toki-q-url{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          #toki-queue-modal .toki-q-del{flex:0 0 auto;background:transparent;border:none;color:#f87171;cursor:pointer;font-size:13px}
          #toki-queue-modal .toki-q-empty{padding:12px;opacity:.6;font-size:12px;text-align:center}
        </style>
        <div class="toki-modal toki-modal-main">
            <div class="toki-modal-header toki-modal-header-borderless">
                <div class="toki-modal-title toki-text-lg">📋 다운로드 큐 ${running ? '<span style="color:#34d399">(실행 중)</span>' : ''}</div>
            </div>
            <div class="toki-section-title toki-mt-0">시리즈 URL 추가 (줄바꿈으로 여러 개)</div>
            <div class="toki-control-group">
                <textarea id="toki-q-input" class="toki-textarea" rows="4" placeholder="https://.../comic/12345&#10;https://.../webtoon/67890"></textarea>
            </div>
            <div class="toki-btn-group-row">
                <button id="toki-q-add" class="toki-btn-action toki-btn-secondary">+ 추가</button>
                <button id="toki-q-add-cur" class="toki-btn-action toki-btn-secondary">+ 현재 페이지</button>
            </div>
            <div class="toki-section-title">대기열 (${q.length})</div>
            <div id="toki-q-list" class="toki-q-list">${rows}</div>
            <div class="toki-modal-footer toki-btn-group-row toki-mt-32">
                <button id="toki-q-clear" class="toki-btn-action toki-btn-secondary">비우기</button>
                ${running
                    ? '<button id="toki-q-stop" class="toki-btn-action">⏸️ 정지</button>'
                    : '<button id="toki-q-start" class="toki-btn-action">▶️ 시작</button>'}
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const refresh = () => openQueueModal();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    overlay.querySelector('#toki-q-add').onclick = () => {
        const n = addUrls(document.getElementById('toki-q-input').value);
        tokiAlert(n > 0 ? `${n}개 추가됨` : '추가된 URL이 없습니다 (중복 또는 형식 오류).');
        refresh();
    };
    overlay.querySelector('#toki-q-add-cur').onclick = () => {
        const n = addUrls(location.href);
        tokiAlert(n > 0 ? '현재 페이지 추가됨' : '이미 큐에 있습니다.');
        refresh();
    };
    overlay.querySelectorAll('.toki-q-del').forEach(btn => {
        btn.onclick = () => {
            const i = parseInt(btn.dataset.i, 10);
            const arr = getQueue(); arr.splice(i, 1); saveQueue(arr); refresh();
        };
    });
    overlay.querySelector('#toki-q-clear').onclick = () => { clearQueue(); refresh(); };
    const startBtn = overlay.querySelector('#toki-q-start');
    if (startBtn) startBtn.onclick = () => { overlay.remove(); startQueue(); };
    const stopBtn = overlay.querySelector('#toki-q-stop');
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
