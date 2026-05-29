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
} from './config.js';

const K_LAST_SEQ = 'TOKI_REMOTE_LAST_SEQ';

let _timer = null;
let _started = false;
let _lastProgress = null;

function _gv(k, d) {
    try { return typeof GM_getValue !== 'undefined' ? GM_getValue(k, d) : d; }
    catch { return d; }
}
function _sv(k, v) {
    try { if (typeof GM_setValue !== 'undefined') GM_setValue(k, v); } catch {}
}

function base(url) { return (url || '').replace(/\/+$/, ''); }

/** GM_xmlhttpRequest 기반 JSON 요청 (Promise) */
function gmRequest({ method, url, token, data }) {
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
            headers,
            data: data ? JSON.stringify(data) : undefined,
            timeout: 15000,
            onload: (r) => {
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

async function poll() {
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;

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

function onCaptcha() {
    const cfg = getRemoteConfig();
    if (!cfg.enabled || !cfg.url) return;
    gmRequest({
        method: 'POST',
        url: `${base(cfg.url)}/captcha`,
        token: cfg.token,
        data: {
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
        }
    } catch {}
}

/** 원격 제어 설정 모달 (toki-modal 스타일 재사용) */
export function openRemoteModal() {
    const existing = document.getElementById('toki-remote-modal');
    if (existing) existing.remove();

    const cfg = getRemoteConfig();
    const overlay = document.createElement('div');
    overlay.id = 'toki-remote-modal';
    overlay.className = 'toki-modal-overlay';
    overlay.innerHTML = `
        <div class="toki-modal toki-modal-main">
            <div class="toki-modal-header toki-modal-header-borderless">
                <div class="toki-modal-title toki-text-lg">🌐 원격 제어 설정</div>
            </div>
            <div class="toki-control-group">
                <label class="toki-label" style="display:flex;align-items:center;gap:8px;">
                    <input type="checkbox" id="toki-rm-enabled" ${cfg.enabled ? 'checked' : ''}>
                    원격 제어 활성화 (컨트롤 API 폴링)
                </label>
            </div>
            <div class="toki-control-group">
                <label class="toki-label">컨트롤 API 주소</label>
                <input type="text" id="toki-rm-url" class="toki-input" placeholder="http://192.168.0.x:8787" value="${(cfg.url || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="toki-control-group">
                <label class="toki-label">API 토큰</label>
                <input type="password" id="toki-rm-token" class="toki-input" placeholder="컨트롤 API 토큰" value="${(cfg.token || '').replace(/"/g, '&quot;')}">
            </div>
            <div class="toki-control-group">
                <label class="toki-label">폴링 주기 (초)</label>
                <input type="number" id="toki-rm-poll" class="toki-input" min="2" max="60" value="${cfg.pollSec}">
            </div>
            <div class="toki-modal-footer toki-btn-group-row toki-mt-32">
                <button id="toki-rm-cancel" class="toki-btn-action toki-btn-secondary">취소</button>
                <button id="toki-rm-save" class="toki-btn-action">저장 (새로고침)</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    const cancel = overlay.querySelector('#toki-rm-cancel');
    if (cancel) cancel.onclick = () => overlay.remove();

    overlay.querySelector('#toki-rm-save').onclick = () => {
        _sv(CFG_REMOTE_ENABLED, overlay.querySelector('#toki-rm-enabled').checked ? '1' : '0');
        _sv(CFG_REMOTE_API_URL, overlay.querySelector('#toki-rm-url').value.trim());
        _sv(CFG_REMOTE_API_TOKEN, overlay.querySelector('#toki-rm-token').value.trim());
        _sv(CFG_REMOTE_POLL_SEC, String(parseInt(overlay.querySelector('#toki-rm-poll').value, 10) || 5));
        _sv(K_LAST_SEQ, '-1'); // 설정 변경 시 기준선 재설정
        overlay.remove();
        try { location.reload(); } catch {}
    };
}
