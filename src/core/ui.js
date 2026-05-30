/**
 * UI Module for TokiSync
 * Handles Logging Overlay and OS Notifications
 */

import { startSilentAudio, stopSilentAudio, isAudioRunning } from './anti_sleep.js';
import { getConfig, setConfig } from './config.js';
import { ParserFactory } from './parsers/ParserFactory.js';
import { RuleManager } from './parsers/RuleManager.js';
import { GenericParser } from './parsers/GenericParser.js';
import { extractEpisodeData } from './extractor.js';
import styles from './ui.css';

// ===== [custom] 비-블로킹 모달 다이얼로그 (native confirm/alert/prompt 대체) =====
// native dialog는 페이지 렌더러를 동기적으로 멈춰 CDP 자동화/모달 UX 충돌을 일으킴.
// 모두 Promise 반환 — async 호출처에서 await 사용.

function _tokiModalShell(bodyHtml, opts = {}) {
    return new Promise(resolve => {
        const ov = document.createElement('div');
        ov.className = 'dsx-modal-dialog';
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,sans-serif';
        ov.innerHTML = `<div style="background:#fff;color:#222;padding:18px 22px;border-radius:8px;min-width:320px;max-width:560px;box-shadow:0 8px 40px #0006">${bodyHtml}</div>`;
        document.body.appendChild(ov);
        const cleanup = (val) => { window.removeEventListener('keydown', kh); ov.remove(); resolve(val); };
        const kh = (e) => { if (e.key === 'Escape') cleanup(opts.escValue !== undefined ? opts.escValue : null); };
        window.addEventListener('keydown', kh);
        opts.bind && opts.bind(ov, cleanup);
        if (opts.dismissOnBackdrop !== false) {
            ov.addEventListener('click', e => { if (e.target === ov) cleanup(opts.escValue !== undefined ? opts.escValue : null); });
        }
    });
}

export function tokiAlert(message) {
    const html = `
        <div style="white-space:pre-wrap;margin-bottom:14px">${String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
        <div style="text-align:right">
            <button data-act="ok" style="padding:6px 14px;background:#1a73e8;color:#fff;border:1px solid #1a73e8;border-radius:4px;cursor:pointer;font-weight:600">확인</button>
        </div>`;
    return _tokiModalShell(html, {
        escValue: undefined,
        bind: (ov, cleanup) => {
            const b = ov.querySelector('[data-act="ok"]');
            b.focus();
            b.onclick = () => cleanup(undefined);
        }
    });
}

export function tokiConfirm(message, opts = {}) {
    const okText = opts.okText || '확인';
    const cancelText = opts.cancelText || '취소';
    const html = `
        <div style="white-space:pre-wrap;margin-bottom:14px">${String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
        <div style="text-align:right;display:flex;gap:8px;justify-content:flex-end">
            <button data-act="cancel" style="padding:6px 14px;background:#fff;color:#333;border:1px solid #ccc;border-radius:4px;cursor:pointer">${cancelText}</button>
            <button data-act="ok" style="padding:6px 14px;background:${opts.danger ? '#ea4335' : '#1a73e8'};color:#fff;border:1px solid ${opts.danger ? '#ea4335' : '#1a73e8'};border-radius:4px;cursor:pointer;font-weight:600">${okText}</button>
        </div>`;
    return _tokiModalShell(html, {
        escValue: false,
        bind: (ov, cleanup) => {
            const ok = ov.querySelector('[data-act="ok"]');
            ok.focus();
            ok.onclick = () => cleanup(true);
            ov.querySelector('[data-act="cancel"]').onclick = () => cleanup(false);
        }
    });
}

export function tokiPrompt(message, defaultValue = '', opts = {}) {
    const multiline = !!opts.multiline;
    const inputHtml = multiline
        ? `<textarea data-input style="width:100%;box-sizing:border-box;padding:6px;font:13px/1.4 ui-monospace,monospace;min-height:100px">${String(defaultValue).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</textarea>`
        : `<input data-input type="text" value="${String(defaultValue).replace(/"/g,'&quot;')}" style="width:100%;box-sizing:border-box;padding:6px;font:13px/1.4 ui-monospace,monospace" />`;
    const html = `
        <div style="white-space:pre-wrap;margin-bottom:10px">${String(message).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>
        ${inputHtml}
        <div style="text-align:right;margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
            <button data-act="cancel" style="padding:6px 14px;background:#fff;color:#333;border:1px solid #ccc;border-radius:4px;cursor:pointer">취소</button>
            <button data-act="ok" style="padding:6px 14px;background:#1a73e8;color:#fff;border:1px solid #1a73e8;border-radius:4px;cursor:pointer;font-weight:600">확인</button>
        </div>`;
    return _tokiModalShell(html, {
        escValue: null,
        bind: (ov, cleanup) => {
            const inp = ov.querySelector('[data-input]');
            inp.focus();
            if (!multiline) inp.select();
            const ok = () => cleanup(inp.value);
            ov.querySelector('[data-act="ok"]').onclick = ok;
            ov.querySelector('[data-act="cancel"]').onclick = () => cleanup(null);
            if (!multiline) {
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
            }
        }
    });
}

export class LogBox {
    static instance = null;

    constructor() {
        if (LogBox.instance) return LogBox.instance;
        this.logs = [];
        this.MAX_LOGS = 500;
        this.init();
        LogBox.instance = this;
    }

    init() {
        if (document.getElementById('dsx-logbox')) return;

        // -- Styles --
        const styleId = 'dsx-logbox-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.innerHTML = styles;
            document.head.appendChild(style);
        }

        // -- HTML --
        this.container = document.createElement('div');
        this.container.id = 'dsx-logbox';
        this.container.innerHTML = `
            <div id="dsx-logbox-header">
                <span id="dsx-logbox-title">TokiSync Log</span>
                <div id="dsx-logbox-controls">
                    <span id="dsx-btn-report" title="버그 리포트 복사" class="dsx-cursor-pointer dsx-text-warning">📋</span>
                    <span id="dsx-btn-audio" title="백그라운드 모드" class="dsx-cursor-pointer">🔊</span>
                    <span id="dsx-btn-clear" title="Clear">🚫</span>
                    <span id="dsx-btn-close" title="Hide">❌</span>
                </div>
            </div>
            <ul id="dsx-logbox-content"></ul>
        `;
        document.body.appendChild(this.container);

        // -- Events --
        this.list = this.container.querySelector('#dsx-logbox-content');
        
        document.getElementById('dsx-btn-report').onclick = () => this.exportReport();
        document.getElementById('dsx-btn-clear').onclick = () => this.clear();
        document.getElementById('dsx-btn-close').onclick = () => this.hide();

        // ESC Key Support for LogBox
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.container.classList.contains('dsx-visible-flex')) {
                this.hide();
            }
        });
        
        // Anti-Sleep Button
        const audioBtn = document.getElementById('dsx-btn-audio');
        if (audioBtn) {
            audioBtn.onclick = () => {
                try {
                    if (isAudioRunning()) {
                        stopSilentAudio();
                        audioBtn.textContent = '🔊';
                        audioBtn.title = '백그라운드 모드 (꺼짐)';
                        this.log('[Anti-Sleep] 백그라운드 모드 비활성화');
                    } else {
                        startSilentAudio();
                        audioBtn.textContent = '🔇';
                        audioBtn.title = '백그라운드 모드 (켜짐)';
                        this.log('[Anti-Sleep] 백그라운드 모드 활성화', 'success');
                    }
                } catch (e) {
                    this.error(`[Anti-Sleep] 실패: ${e.message}`);
                }
            };

            // Sync UI with initial state (if auto-started by downloader)
            setInterval(() => {
                const running = isAudioRunning();
                if (running && audioBtn.textContent === '🔊') {
                    audioBtn.textContent = '🔇';
                    audioBtn.title = '백그라운드 모드 (켜짐)';
                } else if (!running && audioBtn.textContent === '🔇') {
                    audioBtn.textContent = '🔊';
                    audioBtn.title = '백그라운드 모드 (꺼짐)';
                }
            }, 1000);
        }

    }

    static getInstance() {
        if (!LogBox.instance) {
            new LogBox();
        }
        return LogBox.instance;
    }

    log(msg, type = 'normal', context = '') {
        if (!this.list) return;

        const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const prefix = context ? `[${context}] ` : '';
        const fullMsg = `[${time}] ${prefix}${msg}`;
        
        // Save to memory
        this.logs.push({ time, type, context, msg: typeof msg === 'string' ? msg : JSON.stringify(msg) });
        if (this.logs.length > this.MAX_LOGS) this.logs.shift();

        const li = document.createElement('li');
        li.textContent = fullMsg;
        
        if (type === 'error') li.classList.add('error');
        if (type === 'success') li.classList.add('success');

        this.list.appendChild(li);
        this.list.scrollTop = this.list.scrollHeight;
    }

    critical(msg, context = '') {
        this.show(); // Always surface critical errors
        this.log(msg, 'critical', context);
    }

    error(msg, context = '') {
        this.show(); // Auto-show on error
        this.log(msg, 'error', context);
    }

    warn(msg, context = '') {
        this.log(msg, 'warn', context);
    }

    success(msg, context = '') {
        this.log(msg, 'success', context);
    }

    clear() {
        if (this.list) this.list.innerHTML = '';
        this.logs = [];
    }

    show() {
        if (this.container) this.container.classList.add('dsx-visible-flex');
    }

    hide() {
        if (this.container) this.container.classList.remove('dsx-visible-flex');
    }

    async exportReport() {
        const version = typeof GM_info !== 'undefined' ? GM_info.script.version : 'Unknown';
        const ua = navigator.userAgent;
        // Include query parameters for accurate book ID tracking
        let currentUrl = window.location.href;
        // Sanitize sensitive tokens if any (like '?token=')
        currentUrl = currentUrl.replace(/([&?])(token|key|pwd)=[^&]+/g, '$1$2=***');
        
        // Retrieve run settings
        const config = getConfig();
        const dest = config.destination || 'native';
        const isCbz = config.saveAs === 'cbz';
        const smartSkip = config.useSmartSkip ? 'ON' : 'OFF';

        // Severity grouping
        const critical = this.logs.filter(l => l.type === 'critical');
        const warn     = this.logs.filter(l => l.type === 'warn' || l.type === 'error');
        const info     = this.logs.filter(l => l.type !== 'critical' && l.type !== 'warn' && l.type !== 'error');

        const fmt = (logs) => logs.length
            ? logs.map(l => { const ctx = l.context ? `[${l.context}] ` : ''; return `[${l.time}] ${ctx}${l.msg}`; }).join('\n')
            : '(없음)';

        const report = `### 🐞 TokiSync Bug Report

**System Information:**
- **Version:** ${version}
- **URL:** \`${currentUrl}\`
- **User Agent:** ${ua}

**Execution Settings:**
- **Destination:** \`${dest}\`
- **Format:** \`${isCbz ? 'CBZ Archive' : 'Raw Images'}\`
- **Smart Skip:** \`${smartSkip}\`

### 🔴 CRITICAL (작업 중단 오류)
\`\`\`
${fmt(critical)}
\`\`\`

### 🟡 WARN (비치명 / 폴백 발생)
\`\`\`
${fmt(warn)}
\`\`\`

### ⚪ INFO (정상 흐름)
\`\`\`
${fmt(info)}
\`\`\`
`.trim();

        try {
            // Priority: GM_setClipboard > navigator.clipboard > execCommand
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(report);
            } else if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(report);
            } else {
                const textArea = document.createElement("textarea");
                textArea.value = report;
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                } catch (err) {
                    console.error('Copy Failed', err);
                }
                document.body.removeChild(textArea);
            }
            
            this.success('버그 리포트가 클립보드에 복사되었습니다.', 'System');
            Notifier.notify('TokiSync 버그 리포트', '클립보드 복사 완료! GitHub 이슈 탭이 열립니다.');
            
            setTimeout(() => {
                window.open('https://github.com/pray4skylark/tokiSync/issues/new', '_blank');
            }, 800);
            
        } catch (e) {
            this.error('리포트 복사실패: ' + e.message, 'System');
        }
    }

    toggle() {
        if (!this.container) return;
        if (!this.container.classList.contains('dsx-visible-flex')) {
            this.show();
        } else {
            this.hide();
        }
    }

}

export class Notifier {
    /**
     * Send OS Notification
     * @param {string} title 
     * @param {string} text 
     * @param {Function} onclick 
     */
    static notify(title, text, onclick = null) {
        if (typeof GM_notification === 'function') {
            GM_notification({
                title: title,
                text: text,
                timeout: 5000,
                onclick: onclick
            });
        } else {
            // Fallback
            console.log(`[Notification] ${title}: ${text}`);
            // Do not use tokiAlert() as it blocks execution
        }
    }
}

/**
 * MenuModal (v1.5.0)
 * Unified Menu with Accordion & FAB
 */
export class MenuModal {
    static instance = null;

    constructor(handlers = {}) {
        if (MenuModal.instance) return MenuModal.instance;
        this.handlers = handlers; // { onDownload, openViewer, openSettings, toggleLog, ... }
        this.init();
        MenuModal.instance = this;
    }

    init() {
        if (document.getElementById('dsx-menu-fab')) return;
        
        // 1. Create FAB
        this.createFAB();
        
        // 2. Keyboard Shortcut (Ctrl+Shift+T & ESC)
        window.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't' || e.code === 'KeyT')) {
                e.preventDefault();
                this.toggle();
            }
            if (e.key === 'Escape') {
                const overlay = document.querySelector('.dsx-modal-overlay');
                if (overlay) this.close(overlay);
            }
        });
    }

    createFAB() {
        const fab = document.createElement('div');
        fab.id = 'dsx-menu-fab';
        fab.className = 'dsx-fab';
        fab.title = 'TokiSync 메뉴 (Ctrl+Shift+T)';
        fab.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>`;
        
        fab.onclick = () => this.show();
        document.body.appendChild(fab);
    }

    render() {
        // Retrieve current config for UI state
        // We assume config is available or we pass it. For simplicity, we read it here if available, 
        // but ui.js doesn't import config directly to avoid circular dependency if possible.
        // Better to pass current state or read from GM_getValue directly purely for UI init if needed.
        
        const overlay = document.createElement('div');
        overlay.className = 'dsx-modal-overlay';
        overlay.onclick = (e) => { if(e.target === overlay) this.close(overlay); };

        const modal = document.createElement('div');
        modal.className = 'dsx-modal';
        overlay.appendChild(modal);

        // -- Header --
        const header = document.createElement('div');
        header.className = 'dsx-modal-header';
        header.innerHTML = `
            <div class="dsx-modal-title"><span>⚡ TokiSync</span></div>
            <div class="dsx-flex-row">
                <button class="dsx-btn-ghost" id="dsx-btn-viewer-link" title="Open Viewer">
                    🌐 <span>Viewer</span>
                </button>
                <button class="dsx-modal-close" id="dsx-btn-menu-close" title="Close">&times;</button>
            </div>
        `;
        modal.appendChild(header);

        // -- Tabs Header --
        const tabsHeader = document.createElement('div');
        tabsHeader.className = 'dsx-tabs';
        tabsHeader.innerHTML = `
            <button class="dsx-tab-btn active" data-tab="download">📥 다운로드</button>
            <button class="dsx-tab-btn" data-tab="settings">⚙️ 설정</button>
            <button class="dsx-tab-btn" data-tab="history">📊 기록</button>
            <button class="dsx-tab-btn" data-tab="tools">🛠️ 도구</button>
        `;
        modal.appendChild(tabsHeader);

        // -- Body --
        const body = document.createElement('div');
        body.className = 'dsx-modal-body';
        
        // 1. Download Tab
        const tabDown = document.createElement('div');
        tabDown.className = 'dsx-tab-content active';
        tabDown.id = 'dsx-tab-download';
        tabDown.innerHTML = `
                <div class="dsx-control-group">
                    <label class="dsx-label">빠른 작업</label>
                    <button class="dsx-btn-action dsx-btn-gradient-green" id="dsx-btn-down-current">
                        <span>🚀 현재 회차 즉시 다운로드</span>
                    </button>
                </div>
                <hr class="dsx-divider">
                <div class="dsx-control-group">
                    <label class="dsx-label">에피소드 범위 지정</label>
                    <input type="text" id="dsx-range-input" class="dsx-input"
                        placeholder="예: 1,2,4-10,15 (비우면 전체)">
                    <div class="dsx-text-xs dsx-mt-8 dsx-ml-4">쉼표(,)로 개별 번호, 하이픈(-)으로 연속 범위 지정</div>
                </div>
                <div class="dsx-control-group dsx-mb-24">
                    <label class="dsx-checkbox-wrapper">
                        <input type="checkbox" id="dsx-chk-force-overwrite" class="dsx-checkbox-input">
                        <span class="dsx-checkbox"></span>
                        <span class="dsx-checkbox-label">⚠️ 강제 재다운로드 (파일 덮어쓰기)</span>
                    </label>
                </div>
                <div class="dsx-btn-group-row">
                    <button class="dsx-btn-action dsx-flex-1-4" id="dsx-btn-down-range">
                        <span>선택 다운로드</span>
                    </button>
                    <button class="dsx-btn-action dsx-btn-secondary" id="dsx-btn-down-all">
                        <span>전체</span>
                    </button>
                </div>
        `;
        body.appendChild(tabDown);

        // 2. Settings Tab (Unified v1.9.1)
        const tabSettings = document.createElement('div');
        tabSettings.className = 'dsx-tab-content';
        tabSettings.id = 'dsx-tab-settings';
        tabSettings.innerHTML = `
            <div class="dsx-section-title dsx-mt-0">Download Settings</div>
            <div class="dsx-control-group">
                <label class="dsx-label">저장 정책</label>
                <select id="dsx-sel-policy" class="dsx-select">
                    <option value="individual">개별 파일</option>
                    <option value="zipOfCbzs">챕터 묶음</option>
                    <option value="native">자동 분류 (NAS)</option>
                    <option value="drive">드라이브</option>
                </select>
            </div>
            
            <div class="dsx-control-group">
                <label class="dsx-label">다운로드 속도</label>
                <select id="dsx-sel-speed" class="dsx-select">
                    <option value="agile">빠름</option>
                    <option value="cautious">신중</option>
                    <option value="thorough">철저</option>
                    <option value="slow">느림</option>
                    <option value="very_slow">매우 느림</option>
                </select>
            </div>

            <div id="dsx-native-helper" class="dsx-hidden dsx-helper-box-blue">
                <div class="dsx-text-sm dsx-text-primary dsx-mb-10 dsx-helper-desc">
                    📡 NAS WebDAV로 직접 업로드합니다. 상세 설정에서 WebDAV URL/계정을 입력하세요.
                </div>
                <button class="dsx-btn-action dsx-btn-secondary dsx-btn-sm" id="dsx-btn-test-native">
                    📡 WebDAV 연결 테스트
                </button>
            </div>

            <div class="dsx-section-title">Novel Settings</div>
            <div class="dsx-form-grid">
                <div class="dsx-control-group">
                    <label class="dsx-label">소설 포맷</label>
                    <select id="dsx-sel-novel-format" class="dsx-select">
                        <option value="epub">EPUB</option>
                        <option value="txt">TXT</option>
                    </select>
                </div>
                <div class="dsx-control-group">
                    <label class="dsx-label">Smart Skip</label>
                    <select id="dsx-sel-smartskip" class="dsx-select">
                        <option value="90">90% (민감)</option>
                        <option value="70">70% (보통)</option>
                        <option value="50">50% (기본)</option>
                    </select>
                </div>
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">소설 패키징</label>
                <select id="dsx-sel-novel-mode" class="dsx-select">
                    <option value="perChapter">회차별 개별 저장</option>
                    <option value="singleVolume">범위 합본 저장</option>
                </select>
            </div>

            <div class="dsx-section-title">Configuration</div>
            <button class="dsx-btn-action dsx-btn-secondary dsx-btn-slate" id="dsx-btn-advanced">
                🛠️ 상세 주소 및 API 키 설정 (Advanced)
            </button>
        `;
        body.appendChild(tabSettings);

        // 3. History Tab (NEW)
        const tabHistory = document.createElement('div');
        tabHistory.className = 'dsx-tab-content';
        tabHistory.id = 'dsx-tab-history';
        tabHistory.innerHTML = `
            <div class="dsx-info-card">
                <div class="dsx-info-row">
                    <span class="dsx-info-label">동기화 상태</span>
                    <span class="dsx-info-val"><span class="dsx-status-dot dsx-status-online"></span>연결됨</span>
                </div>
                <div class="dsx-info-row">
                    <span class="dsx-info-label">마지막 동기화</span>
                    <span class="dsx-info-val" id="dsx-txt-last-sync">-</span>
                </div>
            </div>
            <div class="dsx-control-group">
                <button class="dsx-btn-action dsx-btn-sync" id="dsx-btn-sync-now">
                    <span>🔄 지금 즉시 동기화</span>
                </button>
            </div>
            <p class="dsx-text-xs dsx-text-center dsx-line-16">
                구글 드라이브의 데이터를 기반으로 목록에 완료 표시(✅)를 업데이트합니다.
            </p>
        `;
        body.appendChild(tabHistory);

        // 4. Tools Tab (Renamed from System)
        const tabTools = document.createElement('div');
        tabTools.className = 'dsx-tab-content';
        tabTools.id = 'dsx-tab-tools';
        tabTools.innerHTML = `
                <div class="dsx-control-group">
                    <label class="dsx-label">파일 관리</label>
                    <div class="dsx-btn-group-stack">
                        <button class="dsx-btn-action dsx-btn-secondary" id="dsx-btn-migration">
                            📂 기존 파일명 표준화 (Migration)
                        </button>
                        <button class="dsx-btn-action dsx-btn-secondary" id="dsx-btn-thumb-optim">
                            🔄 썸네일 통합 및 캐 최적화
                        </button>
                    </div>
                </div>
                <hr class="dsx-divider">
                <div class="dsx-control-group">
                    <label class="dsx-label">시스템 도구</label>
                    <div class="dsx-btn-group-stack">
                        <button class="dsx-btn-action dsx-btn-secondary" id="dsx-btn-log">
                            📝 실시간 로그창 토글
                        </button>
                        <button class="dsx-btn-action dsx-btn-indigo" id="dsx-btn-tree-editor">
                            🧩 파싱 규칙 편집기 (Tree Editor)
                        </button>
                    </div>
                </div>
        `;
        body.appendChild(tabTools);

        modal.appendChild(body);
        document.body.appendChild(overlay);

        // --- Bind Events & Init Logic ---
        this.bindEvents(overlay);
    }

    // Helper removed as no longer using accordion

    bindEvents(overlay) {
        // Tab Switching Logic
        const tabBtns = overlay.querySelectorAll('.dsx-tab-btn');
        const tabContents = overlay.querySelectorAll('.dsx-tab-content');

        tabBtns.forEach(btn => {
            btn.onclick = () => {
                const target = btn.getAttribute('data-tab');
                
                // Toggle Buttons
                tabBtns.forEach(b => b.classList.toggle('active', b === btn));
                // Toggle Contents
                tabContents.forEach(c => {
                    c.classList.toggle('active', c.id === `dsx-tab-${target}`);
                });
            };
        });

        // Headers
        const closeBtn = document.getElementById('dsx-btn-menu-close');
        if (closeBtn) closeBtn.onclick = () => this.close(overlay);
        
        const viewerLink = document.getElementById('dsx-btn-viewer-link');
        if (viewerLink) viewerLink.onclick = () => {
             if(this.handlers.openViewer) this.handlers.openViewer();
        };

        // 1. Download Tab
        const downAllBtn = document.getElementById('dsx-btn-down-all');
        if (downAllBtn) downAllBtn.onclick = () => {
            const force = document.getElementById('dsx-chk-force-overwrite').checked;
            if(this.handlers.downloadAll) this.handlers.downloadAll(force);
            this.close(overlay);
        };

        const downRangeBtn = document.getElementById('dsx-btn-down-range');
        if (downRangeBtn) downRangeBtn.onclick = () => {
            const spec = document.getElementById('dsx-range-input').value.trim();
            const force = document.getElementById('dsx-chk-force-overwrite').checked;
            if (this.handlers.downloadRange) {
                this.handlers.downloadRange(spec || undefined, force);
            }
            this.close(overlay);
        };

        const downCurrentBtn = document.getElementById('dsx-btn-down-current');
        if (downCurrentBtn) downCurrentBtn.onclick = () => {
             if(this.handlers.downloadCurrent) this.handlers.downloadCurrent();
             this.close(overlay);
        };

        const testExtractBtn = document.getElementById('dsx-btn-test-extract');
        if (testExtractBtn) testExtractBtn.onclick = () => {
             if(this.handlers.testExtraction) this.handlers.testExtraction();
        };

        // 2. Settings Tab
        const selPolicy = document.getElementById('dsx-sel-policy');
        const selSpeed = document.getElementById('dsx-sel-speed');
        const selNovelTerm = document.getElementById('dsx-sel-novel-mode');

        // Load Initial Values
        if (this.handlers.getConfig) {
            const cfg = this.handlers.getConfig();
            if (cfg.policy && selPolicy) selPolicy.value = cfg.policy;
            if (cfg.sleepMode && selSpeed) selSpeed.value = cfg.sleepMode;
            if (cfg.novelMode && selNovelTerm) selNovelTerm.value = cfg.novelMode;
        }

        if (selPolicy) {
            selPolicy.onchange = () => { 
                if(this.handlers.setConfig) this.handlers.setConfig('TOKI_DOWNLOAD_POLICY', selPolicy.value);
                this.updateNativeHelper(selPolicy.value);
            };
            this.updateNativeHelper(selPolicy.value);
        }
        
        const testNativeBtn = document.getElementById('dsx-btn-test-native');
        if (testNativeBtn) {
            testNativeBtn.onclick = async () => {
                if (this.handlers.testNativeDownload) {
                    testNativeBtn.disabled = true;
                    testNativeBtn.textContent = '⏳ 테스트 중...';
                    const success = await this.handlers.testNativeDownload();
                    if (success) {
                        testNativeBtn.textContent = '✅ 연결 성공 (NAS 확인)';
                        testNativeBtn.classList.add('dsx-text-success');
                        testNativeBtn.classList.remove('dsx-text-danger');
                    } else {
                        testNativeBtn.textContent = '❌ 연결 실패 (설정 확인)';
                        testNativeBtn.classList.add('dsx-text-danger');
                        testNativeBtn.classList.remove('dsx-text-success');
                    }
                    setTimeout(() => {
                        testNativeBtn.disabled = false;
                        testNativeBtn.textContent = '📡 WebDAV 연결 테스트';
                        testNativeBtn.classList.remove('dsx-text-success', 'dsx-text-danger');
                    }, 3000);
                }
            };
        }

        if (selSpeed) selSpeed.onchange = () => { if(this.handlers.setConfig) this.handlers.setConfig('TOKI_SLEEP_MODE', selSpeed.value); };
        if (selNovelTerm) selNovelTerm.onchange = () => { if(this.handlers.setConfig) this.handlers.setConfig('TOKI_NOVEL_MODE', selNovelTerm.value); };

        const advancedBtn = document.getElementById('dsx-btn-advanced');
        if (advancedBtn) advancedBtn.onclick = () => {
            if(this.handlers.openSettings) this.handlers.openSettings();
            this.close(overlay); 
        };

        // 3. History Tab
        const syncBtn = document.getElementById('dsx-btn-sync-now');
        if (syncBtn) {
            syncBtn.onclick = async () => {
                if (this.handlers.syncHistory) {
                    syncBtn.disabled = true;
                    syncBtn.innerHTML = '<span>⏳ 동기화 중...</span>';
                    await this.handlers.syncHistory();
                    syncBtn.disabled = false;
                    syncBtn.innerHTML = '<span>🔄 지금 즉시 동기화</span>';
                    
                    const timeEl = document.getElementById('dsx-txt-last-sync');
                    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
                }
            };
        }

        // 4. Tools Tab
        const migrationBtn = document.getElementById('dsx-btn-migration');
        if (migrationBtn) migrationBtn.onclick = () => {
            if(this.handlers.migrateFilenames) this.handlers.migrateFilenames();
            this.close(overlay);
        };

        const thumbBtn = document.getElementById('dsx-btn-thumb-optim');
        if (thumbBtn) thumbBtn.onclick = () => {
            if(this.handlers.migrateThumbnails) this.handlers.migrateThumbnails();
            this.close(overlay);
        };

        const logBtn = document.getElementById('dsx-btn-log');
        if (logBtn) logBtn.onclick = () => {
            if(this.handlers.toggleLog) this.handlers.toggleLog();
        };

        const treeEditorBtn = document.getElementById('dsx-btn-tree-editor');
        if (treeEditorBtn) treeEditorBtn.onclick = () => {
            const editor = new TreeRuleEditor();
            editor.show();
        };
    }

    // getEpisodeRange 핸들러는 슬라이더 제거로 더 이상 UI에서 사용 안 함 (main.js 호환용으로 유지)

    show() {
        this.render();
    }

    close(overlay) {
        if(overlay) {
            // overlay.style.transition = 'opacity 0.2s'; // CSS handles transition
            overlay.classList.add('dsx-hidden');
            setTimeout(() => overlay.remove(), 200);
        }
    }

    toggle() {
        const existing = document.querySelector('.dsx-modal-overlay');
        if (existing) this.close(existing);
        else this.show();
    }

    updateNativeHelper(policy) {
        const helper = document.getElementById('dsx-native-helper');
        if (helper) {
            if (policy === 'native') {
                helper.classList.remove('dsx-hidden');
            } else {
                helper.classList.add('dsx-hidden');
            }
        }
    }
}

/**
 * Mark downloaded items in the list (UI Sync)
 * @param {string[]} historyList Array of episode IDs (e.g. ["0001", "0002"])
 */
export async function markDownloadedItems(historyList) {
    if (!historyList || historyList.length === 0) return;

    // Use Set for fast lookup
    const historySet = new Set(historyList.map(id => id.toString())); // Ensure string comparison

    const parser = await ParserFactory.getParser();
    if (!parser) {
        console.warn('[UI] 파서를 찾을 수 없어 다운로드 표시를 생략합니다.');
        return;
    }

    const items = await parser.getListItems();
    let markedCount = 0;

    items.forEach(li => {
        try {
            const item = parser.parseListItem(li);
            if (!item) return; // Skip if parse failed
            
            const { num, element } = item;

            if (num) {
                // Normalize: '0001' -> '1', '1' -> '1' for comparison
                const normalizedNum = parseInt(num).toString();
                
                // Check if ANY items in history set matches this number
                let isDownloaded = historySet.has(num) || historySet.has(normalizedNum);
                
                // Try left-pad match
                if(!isDownloaded && normalizedNum.length < 4) {
                    const padded = normalizedNum.padStart(4, '0');
                    isDownloaded = historySet.has(padded);
                }

                if (isDownloaded) {
                    // Visual Indicator (v1.9.1 Class-based)
                    element.classList.add('dsx-downloaded'); 
                    markedCount++;
                }
            }
        } catch (e) {
            console.warn('[UI] 특정 항목(li) 마킹 중 오류 발생 (건너뜀):', e);
        }
    });

    
    console.log(`[UI] ${markedCount}개 항목에 다운로드 완료 표시 적용.`);
}

/**
 * TreeRuleEditor (v1.9.0)
 * Specialist UI for managing parsing rules with a tree-style interface.
 */
export class TreeRuleEditor {
    constructor() {
        this.rules = RuleManager.getCustomRules();
        this.overlay = null;
        this.hints = {
            'id': '사이트 고유 ID (영문/숫자)',
            'name': '표시용 이름',
            'urlPattern': '적용할 URL 정규표현식',
            'category': 'Webtoon / Manga / Novel',
            'meta': '작품 정보를 추출하는 규칙 그룹',
            'selector': 'CSS 셀렉터 (예: .title, #info)',
            'attr': '추출할 속성 (비워두면 텍스트)',
            'regex': '데이터 정제용 정규식 그룹',
            'list': '회차 목록을 추출하는 규칙 그룹',
            'container': '목록 전체를 감싸는 부모 요소',
            'item': '각 회차 줄 요소 (li 등)',
            'viewer': '본문 내용을 추출하는 규칙 그룹',
            'images': '웹툰 이미지 또는 소설 본문 요소'
        };
    }

    show() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'dsx-modal-overlay';
        // z-index handled by .dsx-tree-modal in ui.css
        
        this.overlay.innerHTML = `
            <div class="dsx-modal dsx-tree-modal">
                <div class="dsx-modal-header">
                    <div class="dsx-modal-title">🧩 파싱 규칙 관리자 (Tree Editor)</div>
                    <div class="dsx-flex-row-8">
                        <button class="dsx-btn-rule" id="tree-btn-export">📤 내보내기</button>
                        <button class="dsx-btn-rule" id="tree-btn-import">📥 가져오기</button>
                        <button class="dsx-modal-close" id="tree-close-btn">&times;</button>
                    </div>
                </div>
                <div class="dsx-tree-container">
                    <div class="dsx-tree-view" id="tree-root"></div>
                    
                    <div class="dsx-tree-right-panel">
                        <div class="dsx-flex-between dsx-text-xs">
                            <span>📄 JSON 미리보기</span>
                            <span id="tree-json-status" class="dsx-text-success">✓ Valid</span>
                        </div>
                        <textarea class="dsx-tree-json-preview" id="tree-json-editor" spellcheck="false"></textarea>
                        
                        <div class="dsx-test-bench dsx-mt-0">
                            <div class="dsx-label dsx-mb-5">🧪 즉시 테스트</div>
                            <div class="dsx-flex-row-8">
                                <input type="text" id="tree-test-url" class="dsx-input-compact dsx-flex-1" placeholder="주소 입력" value="${window.location.href}">
                                <button class="dsx-btn-rule dsx-text-success" id="tree-btn-test">실행</button>
                            </div>
                            <div id="tree-test-result" class="dsx-test-result">규칙 수정 후 바로 테스트해보세요.</div>
                        </div>
                        
                        <div class="dsx-flex-row-10">
                            <button class="dsx-btn-action dsx-btn-lavender" id="tree-btn-save">저장 및 적용</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.overlay);
        this.render();
        this.bindEvents();
    }

    render() {
        const root = this.overlay.querySelector('#tree-root');
        root.innerHTML = '';
        
        const mainNode = document.createElement('div');
        mainNode.innerHTML = `<div class="dsx-tree-item"><span class="dsx-tree-key">Rules [Array]</span><button class="dsx-tree-btn-small" id="tree-add-rule">➕ 룰 추가</button></div>`;
        root.appendChild(mainNode);

        const listNode = document.createElement('div');
        listNode.className = 'dsx-tree-node';
        this.rules.forEach((rule, idx) => {
            listNode.appendChild(this.renderNode(rule, `[${idx}]`, rule.name || rule.id || `Rule ${idx + 1}`));
        });
        root.appendChild(listNode);

        this.updateJsonPreview();
    }

    renderNode(data, path, label = '') {
        const wrapper = document.createElement('div');
        wrapper.className = 'dsx-tree-node-wrapper';

        const item = document.createElement('div');
        item.className = 'dsx-tree-item';
        
        const isObject = data !== null && typeof data === 'object';
        const toggle = document.createElement('span');
        toggle.className = 'dsx-tree-toggle';
        toggle.textContent = isObject ? '▼' : '•';
        
        const keySpan = document.createElement('span');
        keySpan.className = 'dsx-tree-key';
        keySpan.textContent = label || path.split('.').pop();
        if (this.hints[keySpan.textContent]) {
            keySpan.title = this.hints[keySpan.textContent];
        }

        item.appendChild(toggle);
        item.appendChild(keySpan);

        if (!isObject) {
            const input = document.createElement('input');
            input.className = 'dsx-tree-val';
            input.value = data;
            input.dataset.path = path;
            input.oninput = (e) => this.updateValue(path, e.target.value);
            item.appendChild(input);
        } else {
            const actions = document.createElement('div');
            actions.className = 'dsx-tree-actions';
            
            const btnDel = document.createElement('button');
            btnDel.className = 'dsx-tree-btn-small';
            btnDel.textContent = '🗑️';
            btnDel.onclick = () => this.removeNode(path);
            actions.appendChild(btnDel);
            
            item.appendChild(actions);
        }

        wrapper.appendChild(item);

        if (isObject) {
            const children = document.createElement('div');
            children.className = 'dsx-tree-node';
            Object.keys(data).forEach(key => {
                children.appendChild(this.renderNode(data[key], `${path}.${key}`, key));
            });
            wrapper.appendChild(children);

            toggle.onclick = () => {
                children.classList.toggle('dsx-hidden');
                toggle.textContent = isHidden ? '▼' : '▶';
            };
        }

        return wrapper;
    }

    updateValue(path, val) {
        const parts = path.split('.');
        let current = this.rules;
        
        for (let i = 0; i < parts.length; i++) {
            let p = parts[i];
            if (p.startsWith('[') && p.endsWith(']')) {
                p = parseInt(p.substring(1, p.length - 1));
            }
            
            if (i === parts.length - 1) {
                current[p] = val;
            } else {
                current = current[p];
            }
        }
        this.updateJsonPreview();
    }

    async removeNode(path) {
        if (!(await tokiConfirm(`노드(${path})를 삭제하시겠습니까?`, { danger: true, okText: '삭제' }))) return;
        
        const parts = path.split('.');
        if (parts.length === 1) { // Root rule
            const idx = parseInt(parts[0].substring(1, parts[0].length - 1));
            this.rules.splice(idx, 1);
        } else {
            let current = this.rules;
            for (let i = 0; i < parts.length - 1; i++) {
                let p = parts[i];
                if (p.startsWith('[') && p.endsWith(']')) p = parseInt(p.substring(1, p.length - 1));
                current = current[p];
            }
            const last = parts[parts.length - 1];
            delete current[last];
        }
        this.render();
    }

    updateJsonPreview() {
        const editor = this.overlay.querySelector('#tree-json-editor');
        editor.value = JSON.stringify(this.rules, null, 2);
    }

    bindEvents() {
        const overlay = this.overlay;
        
        overlay.querySelector('#tree-close-btn').onclick = () => overlay.remove();
        
        overlay.querySelector('#tree-add-rule').onclick = () => {
            this.rules.push({
                id: 'new_site_' + Date.now(),
                name: '새 사이트',
                urlPattern: '',
                category: 'Webtoon',
                meta: { title: { selector: '' } },
                list: { container: '', item: '' },
                viewer: { images: { selector: '' } }
            });
            this.render();
        };

        overlay.querySelector('#tree-json-editor').oninput = (e) => {
            const status = overlay.querySelector('#tree-json-status');
            try {
                const parsed = JSON.parse(e.target.value);
                if (Array.isArray(parsed)) {
                    this.rules = parsed;
                    status.textContent = '✓ Valid';
                    status.classList.add('dsx-text-success');
                    status.classList.remove('dsx-text-danger');
                    if (this.renderTimer) clearTimeout(this.renderTimer);
                    this.renderTimer = setTimeout(() => this.render(), 1000);
                }
            } catch (err) {
                status.textContent = '⚠ Invalid JSON';
                status.classList.add('dsx-text-danger');
                status.classList.remove('dsx-text-success');
            }
        };

        overlay.querySelector('#tree-btn-save').onclick = async () => {
            RuleManager.saveCustomRules(this.rules);
            await tokiAlert('파싱 규칙이 성공적으로 저장되었습니다.');
            overlay.remove();
        };

        overlay.querySelector('#tree-btn-export').onclick = () => {
            const blob = new Blob([JSON.stringify(this.rules, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tokisync_rules_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };

        overlay.querySelector('#tree-btn-import').onclick = () => {
            const selectOverlay = document.createElement('div');
            selectOverlay.className = 'dsx-modal-overlay';
            selectOverlay.style.zIndex = '20002'; // Above Tree Editor
            selectOverlay.onclick = (e) => { if(e.target === selectOverlay) selectOverlay.remove(); };
            
            selectOverlay.innerHTML = `
                <div class="dsx-modal dsx-compact-modal" style="max-width: 400px; padding: 24px;">
                    <div class="dsx-modal-header" style="margin-bottom: 20px;">
                        <div class="dsx-modal-title" style="font-size: 16px;">📥 규칙 가져오기 방식 선택</div>
                        <button class="dsx-modal-close" id="import-select-close" title="닫기">&times;</button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;">
                        <button class="dsx-btn-action dsx-btn-lavender" id="import-choose-file">
                            📂 로컬 JSON 파일 선택
                        </button>
                        <button class="dsx-btn-action dsx-btn-secondary" id="import-choose-url">
                            🌐 원격 URL 주소 입력
                        </button>
                    </div>
                    <div id="import-url-input-container" class="dsx-hidden" style="margin-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 16px;">
                        <div class="dsx-control-group" style="margin-bottom: 16px;">
                            <label class="dsx-label">원격 규칙 URL 주소</label>
                            <input type="text" id="import-url-input" class="dsx-input" placeholder="https://..." value="https://pray4skylark.github.io/tokiSync/rules.json">
                        </div>
                        <button class="dsx-btn-action" id="import-btn-fetch" style="width: 100%;">
                            <span>가져오기 실행</span>
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(selectOverlay);

            selectOverlay.querySelector('#import-select-close').onclick = () => selectOverlay.remove();

            const handleRulesImport = async (rules) => {
                const rulesArr = Array.isArray(rules) ? rules : (rules.rules || []);
                if (!Array.isArray(rulesArr) || rulesArr.length === 0) {
                    await tokiAlert('가져올 규칙이 유효하지 않거나 비어 있습니다.');
                    return;
                }
                const merge = await tokiConfirm(
                    '기존 규칙과 합치시겠습니까?\n(취소 = 전체 덮어쓰기)',
                    { okText: '합치기', cancelText: '덮어쓰기' }
                );
                if (!merge) {
                    this.rules = rulesArr;
                } else {
                    RuleManager.bulkImport(rulesArr, 'merge');
                    this.rules = RuleManager.getCustomRules();
                }
                this.render();
                selectOverlay.remove();
            };

            // File selection
            selectOverlay.querySelector('#import-choose-file').onclick = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const imported = JSON.parse(ev.target.result);
                            await handleRulesImport(imported);
                        } catch (err) {
                            await tokiAlert('JSON 파싱 오류: ' + err.message);
                        }
                    };
                    reader.readAsText(file);
                };
                input.click();
            };

            // URL input toggle
            selectOverlay.querySelector('#import-choose-url').onclick = () => {
                const container = selectOverlay.querySelector('#import-url-input-container');
                container.classList.remove('dsx-hidden');
            };

            // Fetch remote URL
            selectOverlay.querySelector('#import-btn-fetch').onclick = async () => {
                const url = selectOverlay.querySelector('#import-url-input').value.trim();
                if (!url) {
                    await tokiAlert('URL을 입력해주세요.');
                    return;
                }
                const fetchBtn = selectOverlay.querySelector('#import-btn-fetch');
                fetchBtn.disabled = true;
                fetchBtn.innerHTML = '<span>⏳ 가져오는 중...</span>';

                try {
                    const fetched = await RuleManager.fetchRemoteRules(url);
                    if (fetched) {
                        await handleRulesImport(fetched);
                    } else {
                        await tokiAlert('원격 규칙을 가져오는데 실패했습니다. URL 주소 및 네트워크 상태를 확인하세요.');
                    }
                } catch (err) {
                    await tokiAlert('오류 발생: ' + err.message);
                } finally {
                    fetchBtn.disabled = false;
                    fetchBtn.innerHTML = '<span>가져오기 실행</span>';
                }
            };
        };

        overlay.querySelector('#tree-btn-test').onclick = async () => {
            const res = overlay.querySelector('#tree-test-result');
            res.textContent = '⏳ 파싱 테스트 중...';
            try {
                const url = overlay.querySelector('#tree-test-url').value;
                const domain = new URL(url).origin;
                const rule = this.rules.find(r => new RegExp(r.urlPattern, 'i').test(url));
                if (!rule) throw new Error('해당 URL에 맞는 규칙이 트리 내에 없습니다.');

                const parser = new GenericParser(domain, rule);
                const result = await extractEpisodeData(document, parser, { site: 'test', category: rule.category }, false);
                
                res.innerHTML = `
                    <div class="dsx-text-success">성공!</div>
                    <div>• 제목: ${result.title || 'N/A'}</div>
                    <div>• 항목 수: ${result.urls?.length || (result.content ? '1 (Text)' : '0')}</div>
                `;
            } catch (e) {
                res.textContent = '❌ 실패: ' + e.message;
            }
        };
    }
}

/**
 * showRuleDebugModal — 현재 페이지에 활성 룰을 적용해 다운로드 대상 이미지를 시각화
 * GenericParser/워커와 동일한 알고리즘: imageContainer → imageItem → exclude(closest) → dummy 필터
 */
export async function showRuleDebugModal() {
    document.querySelectorAll('.dsx-rule-debug-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'dsx-rule-debug-overlay';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;pointer-events:none;font:13px/1.5 system-ui,sans-serif;`;
    const initLeft = Math.max(20, (window.innerWidth - Math.min(1100, window.innerWidth * 0.92)) / 2);
    const initTop = Math.max(20, (window.innerHeight - window.innerHeight * 0.88) / 2);
    overlay.innerHTML = `
        <div data-panel style="position:absolute;left:${initLeft}px;top:${initTop}px;background:#fff;color:#222;max-width:1100px;width:92vw;max-height:88vh;border-radius:8px;box-shadow:0 8px 40px #0006;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;resize:both">
            <div data-drag style="padding:10px 14px;border-bottom:1px solid #ddd;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;background:#f5f5f5">
                <strong>🔍 룰 디버그 — 현재 페이지 파싱 미리보기 <small style="color:#888;font-weight:normal">(헤더 드래그로 이동)</small></strong>
                <button data-act="close" style="border:none;background:transparent;font-size:20px;cursor:pointer">✕</button>
            </div>
            <div id="rd-stats" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:10px 14px;background:#fafafa"></div>
            <pre id="rd-log" style="margin:0;padding:8px 14px;background:#f3f3f3;font:11px/1.4 ui-monospace,monospace;max-height:160px;overflow:auto;white-space:pre-wrap"></pre>
            <div style="flex:1;overflow:auto">
                <table id="rd-tbl" style="width:100%;border-collapse:collapse;font-size:12px">
                    <thead style="position:sticky;top:0;background:#eee">
                        <tr><th style="padding:4px 8px;text-align:left">#</th><th style="padding:4px 8px;text-align:left">상태</th><th style="padding:4px 8px;text-align:left">closest 경로</th><th style="padding:4px 8px;text-align:left">URL</th><th style="padding:4px 8px;text-align:left">미리보기</th></tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
            <div style="padding:8px 14px;border-top:1px solid #ddd;display:flex;gap:8px;align-items:center;background:#fafafa">
                <button data-act="rerun" style="padding:5px 12px;cursor:pointer">▶ 다시 분석</button>
                <button data-act="copy-urls" style="padding:5px 12px;cursor:pointer">📋 KEEP URL 복사</button>
                <span style="margin-left:auto;color:#666">ESC 또는 ✕ 로 닫기</span>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const $ = sel => overlay.querySelector(sel);
    const log = (msg) => { $('#rd-log').textContent += msg + '\n'; };
    const clearLog = () => { $('#rd-log').textContent = ''; };

    const close = () => { overlay.remove(); window.removeEventListener('keydown', escHandler); };
    overlay.querySelector('[data-act="close"]').onclick = close;
    const escHandler = e => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', escHandler);

    // 드래그 이동 — 헤더(data-drag)를 잡아 이동
    const panel = overlay.querySelector('[data-panel]');
    const dragHandle = overlay.querySelector('[data-drag]');
    let dragState = null;
    const onMove = (e) => {
        if (!dragState) return;
        const x = (e.touches ? e.touches[0].clientX : e.clientX) - dragState.dx;
        const y = (e.touches ? e.touches[0].clientY : e.clientY) - dragState.dy;
        const maxX = window.innerWidth - 50;
        const maxY = window.innerHeight - 30;
        panel.style.left = Math.min(Math.max(-panel.offsetWidth + 80, x), maxX) + 'px';
        panel.style.top = Math.min(Math.max(0, y), maxY) + 'px';
    };
    const onUp = () => {
        dragState = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
    };
    dragHandle.addEventListener('mousedown', (e) => {
        if (e.target.closest('[data-act]')) return;
        const rect = panel.getBoundingClientRect();
        dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    });
    dragHandle.addEventListener('touchstart', (e) => {
        if (e.target.closest('[data-act]')) return;
        const rect = panel.getBoundingClientRect();
        const t = e.touches[0];
        dragState = { dx: t.clientX - rect.left, dy: t.clientY - rect.top };
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }, { passive: true });

    const isDummyUrl = (url) => {
        if (!url) return true;
        if (url.startsWith('data:image')) return true;
        const l = url.toLowerCase();
        const dummies = ['blank.gif','loading.gif','loading-image.gif','pixel.gif','spacer.gif','transparent.gif','1x1.gif','dot.gif'];
        if (dummies.some(p => l.includes(p))) return true;
        if (/\/img\/(loading|placeholder)/.test(l)) return true;
        return false;
    };
    const selectorOf = (el) => {
        const parts = [];
        let n = el;
        for (let i = 0; i < 3 && n && n.tagName; i++) {
            let s = n.tagName.toLowerCase();
            if (n.id) s += '#' + n.id;
            if (n.className && typeof n.className === 'string') {
                const cls = n.className.trim().split(/\s+/).slice(0, 2).filter(Boolean).map(c => '.' + c).join('');
                s += cls;
            }
            parts.unshift(s);
            n = n.parentElement;
        }
        return parts.join(' > ');
    };

    let lastKeepUrls = [];

    async function analyze() {
        clearLog();
        const tbody = $('#rd-tbl tbody');
        tbody.innerHTML = '';

        log(`[page] ${location.href}`);

        // 등록된 모든 룰 후보 dump — 어느 룰이 우선되는지 시각화
        try {
            const allRules = await RuleManager.getRules();
            log(`[rules] 등록된 룰 ${allRules.length}개 (위에서부터 우선):`);
            allRules.slice(0, 10).forEach((r, i) => {
                const matched = (() => {
                    if (!r.urlPattern) return '⚪ SKIP(빈 urlPattern)';
                    try { return new RegExp(r.urlPattern, 'i').test(location.href) ? '✅ MATCH' : '❌ no-match'; }
                    catch (e) { return '⚠️ invalid regex'; }
                })();
                log(`   ${i+1}. ${matched}  name="${r.name || r.id}"  urlPattern="${r.urlPattern || ''}"`);
            });
            if (allRules.length > 10) log(`   ... +${allRules.length - 10}개 더`);
        } catch (e) { log('[rules] 룰 목록 조회 실패: ' + e.message); }

        const parser = await ParserFactory.getParser();
        if (!parser) {
            log('[parser] ❌ 활성 룰 없음 — 메뉴에서 사이트 룰을 먼저 등록하세요');
            $('#rd-stats').innerHTML = '<div style="grid-column:1/-1;padding:8px;background:#fbe9e7;color:#b71c1c">활성 파서가 없습니다.</div>';
            return;
        }
        const rule = parser.rule || {};
        const viewerCfg = rule.viewer || {};
        log(`[rule] 🎯 실제 매칭: name="${rule.name || rule.id || '(이름 없음)'}"  urlPattern="${rule.urlPattern || '-'}"`);
        log(`[rule] 전체 JSON:`);
        log(JSON.stringify(rule, null, 2));
        log(`[viewer] imageContainer="${viewerCfg.imageContainer || ''}"  imageItem="${viewerCfg.imageItem || 'img'}"`);

        const totalImgs = document.querySelectorAll('img').length;
        log(`[doc] 문서 전체 <img>: ${totalImgs}개`);

        let container = document;
        if (viewerCfg.imageContainer) {
            container = document.querySelector(viewerCfg.imageContainer);
            if (!container) {
                log(`[container] ❌ '${viewerCfg.imageContainer}' DOM에서 못 찾음`);
                render([], totalImgs, 0, 0);
                return;
            }
            log(`[container] ✅ '${viewerCfg.imageContainer}' 발견`);
        } else {
            log(`[container] (지정 없음) — 문서 전체`);
        }

        const itemSel = viewerCfg.imageItem || 'img';
        const matched = Array.from(container.querySelectorAll(itemSel));
        log(`[match] '${itemSel}' → ${matched.length}개`);

        const excludeRule = viewerCfg.exclude || viewerCfg.remove;
        const excludeSelectors = excludeRule
            ? (Array.isArray(excludeRule) ? excludeRule : [excludeRule])
            : [];
        if (excludeSelectors.length) log(`[exclude] ${excludeSelectors.join(' , ')}`);

        const urlExcludeRaw = viewerCfg.urlExclude || viewerCfg.urlBlocklist;
        const urlExcludeList = urlExcludeRaw
            ? (Array.isArray(urlExcludeRaw) ? urlExcludeRaw : [urlExcludeRaw])
            : [];
        if (urlExcludeList.length) log(`[urlExclude] ${urlExcludeList.join(' , ')}`);
        const urlBlockedBy = (url) => {
            if (!url) return null;
            return urlExcludeList.find(p => {
                if (typeof p !== 'string') return false;
                if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
                    try { return new RegExp(p.slice(1, -1)).test(url); } catch (e) { return false; }
                }
                return url.includes(p);
            });
        };

        const lazyAttrs = viewerCfg.lazyAttrOptions || ['data-src', 'data-lazy', 'src'];
        const rows = matched.map(img => {
            const droppedBy = excludeSelectors.find(sel => { try { return !!img.closest(sel); } catch (e) { return false; } });
            let url = '';
            for (const a of lazyAttrs) { const v = img.getAttribute(a); if (v) { url = v; break; } }
            if (!url) url = img.getAttribute('src') || '';
            const dummy = isDummyUrl(url);
            const urlBlock = urlBlockedBy(url);
            let status = 'keep';
            if (droppedBy) status = 'drop:exclude';
            else if (!url) status = 'drop:no-url';
            else if (urlBlock) status = 'drop:url-block';
            else if (dummy) status = 'drop:dummy';
            return { img, url, status, droppedBy: droppedBy || urlBlock };
        });

        const keep = rows.filter(r => r.status === 'keep');
        const dropEx = rows.filter(r => r.status === 'drop:exclude').length;
        const dropUrl = rows.filter(r => r.status === 'drop:url-block').length;
        const dropDum = rows.filter(r => r.status === 'drop:dummy').length;
        const dropEmpty = rows.filter(r => r.status === 'drop:no-url').length;
        log(`[result] keep=${keep.length}  drop_exclude=${dropEx}  drop_url=${dropUrl}  drop_dummy=${dropDum}  drop_no_url=${dropEmpty}`);

        lastKeepUrls = keep.map(r => r.url);
        render(rows, totalImgs, matched.length, keep.length);
    }

    function render(rows, totalImgs, matchedCount, keepCount) {
        const cell = (val, label, bg) => `<div style="padding:8px;background:${bg};border-radius:4px"><b style="font-size:18px;display:block">${val}</b>${label}</div>`;
        $('#rd-stats').innerHTML =
            cell(totalImgs, '문서 전체 img', '#eef') +
            cell(matchedCount, 'selector 매치', '#eef') +
            cell(matchedCount - keepCount, '제외 (exclude/dummy)', '#fdecea') +
            cell(keepCount, '최종 다운로드', '#e6f4ea');

        const tbody = $('#rd-tbl tbody');
        rows.forEach((r, i) => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid #eee';
            const badge = r.status === 'keep'
                ? '<span style="background:#34a85333;color:#1e7e34;padding:1px 6px;border-radius:10px;font-weight:600;font-size:11px">KEEP</span>'
                : r.status === 'drop:exclude'
                    ? `<span style="background:#ea443533;color:#b71c1c;padding:1px 6px;border-radius:10px;font-weight:600;font-size:11px">EXCLUDE</span><br><small style="color:#888">${r.droppedBy}</small>`
                    : r.status === 'drop:url-block'
                        ? `<span style="background:#9c27b033;color:#6a1b9a;padding:1px 6px;border-radius:10px;font-weight:600;font-size:11px">URL-BLOCK</span><br><small style="color:#888">${r.droppedBy}</small>`
                        : r.status === 'drop:dummy'
                            ? '<span style="background:#fbbc0433;color:#856404;padding:1px 6px;border-radius:10px;font-weight:600;font-size:11px">DUMMY</span>'
                            : '<span style="background:#ea443533;color:#b71c1c;padding:1px 6px;border-radius:10px;font-weight:600;font-size:11px">NO URL</span>';
            tr.innerHTML = `
                <td style="padding:4px 8px">${i + 1}</td>
                <td style="padding:4px 8px">${badge}</td>
                <td style="padding:4px 8px;font-family:ui-monospace,monospace;color:#555">${selectorOf(r.img)}</td>
                <td style="padding:4px 8px;font-family:ui-monospace,monospace;word-break:break-all;max-width:340px">${r.url || '<em style="color:#aaa">-</em>'}</td>
                <td style="padding:4px 8px">${r.url ? `<img src="${r.url}" loading="lazy" referrerpolicy="no-referrer" style="max-height:40px;max-width:60px;object-fit:contain" onerror="this.style.opacity=.2">` : ''}</td>`;
            tbody.appendChild(tr);
        });
    }

    overlay.querySelector('[data-act="rerun"]').onclick = analyze;
    overlay.querySelector('[data-act="copy-urls"]').onclick = async () => {
        if (!lastKeepUrls.length) return;
        try {
            await navigator.clipboard.writeText(lastKeepUrls.join('\n'));
            const b = overlay.querySelector('[data-act="copy-urls"]');
            const orig = b.textContent;
            b.textContent = `✅ ${lastKeepUrls.length}개 복사됨`;
            setTimeout(() => b.textContent = orig, 1500);
        } catch (e) { tokiAlert('클립보드 쓰기 실패: ' + e.message); }
    };

    await analyze();
}
