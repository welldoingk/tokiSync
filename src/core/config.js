import { tokiAlert } from './ui.js';

export const CFG_URL_KEY = "TOKI_GAS_URL"; // legacy
export const CFG_ID_KEY = "TOKI_GAS_ID";
export const CFG_FOLDER_ID = "TOKI_FOLDER_ID";
export const CFG_POLICY_KEY = "TOKI_DOWNLOAD_POLICY";
export const CFG_API_KEY = "TOKI_API_KEY";
export const CFG_SLEEP_MODE = "TOKI_SLEEP_MODE";
export const CFG_SMART_SKIP_RATIO = "TOKI_SMART_SKIP_RATIO";
export const CFG_NOVEL_MODE = "TOKI_NOVEL_MODE";
export const CFG_NOVEL_FORMAT = "TOKI_NOVEL_FORMAT";
export const CFG_REMOTE_RULE_URL = "TOKI_REMOTE_RULE_URL";
export const CFG_CUSTOM_RULES = "TOKI_CUSTOM_RULES";
export const CFG_GLOBAL_URL_EXCLUDE = "TOKI_GLOBAL_URL_EXCLUDE";
export const CFG_CBZ_COMPRESSION = "TOKI_CBZ_COMPRESSION"; // "DEFLATE" | "STORE"
export const CFG_CONCURRENCY = "TOKI_CONCURRENCY";         // 1 = sequential (default), 2+ = parallel chapters
export const CFG_SCROLL_TIMEOUT_MS = "TOKI_SCROLL_TIMEOUT_MS"; // ms, default 20000
export const CFG_WEBDAV_URL = "TOKI_WEBDAV_URL";   // 예: http://192.168.0.50:5005/books
export const CFG_WEBDAV_USER = "TOKI_WEBDAV_USER";
export const CFG_WEBDAV_PASS = "TOKI_WEBDAV_PASS";
export const CFG_IMG_CONCURRENCY = "TOKI_IMG_CONCURRENCY"; // 회차 내 이미지 동시 다운로드 수 (기본 8)
export const CFG_WAF_JITTER_SEC = "TOKI_WAF_JITTER_SEC";   // 회차 사이 WAF 지터 기준 초 (기본 3 → 3~5초)
export const CFG_FORCE_OPEN_SHADOW = "TOKI_FORCE_OPEN_SHADOW"; // 닫힌 shadow 강제 open(소설 본문 추출용, 기본 OFF)
// -- 원격 제어 (컨트롤 API 폴링) --
export const CFG_REMOTE_ENABLED = "TOKI_REMOTE_ENABLED";   // "1" | "0"
export const CFG_REMOTE_API_URL = "TOKI_REMOTE_API_URL";   // 예: http://192.168.0.x:8787
export const CFG_REMOTE_API_TOKEN = "TOKI_REMOTE_API_TOKEN";
export const CFG_REMOTE_POLL_SEC = "TOKI_REMOTE_POLL_SEC"; // 폴링 주기(초), 기본 5
export const CFG_REMOTE_CLIENT_ID = "TOKI_REMOTE_CLIENT_ID"; // 멀티-IP 식별 라벨(예: A-direct). 설정 시 lease 모드
export const CFG_REMOTE_LEASE_MAX = "TOKI_REMOTE_LEASE_MAX"; // 동시 보유 lease 목표 수(기본 2)

/**
 * [custom] CBZ 압축 모드 — DEFLATE (기본, 작음/느림) 또는 STORE (큼/빠름)
 */
export function getCbzCompression() {
    if (typeof GM_getValue === 'undefined') return 'DEFLATE';
    const v = (GM_getValue(CFG_CBZ_COMPRESSION, 'DEFLATE') || '').toUpperCase();
    return v === 'STORE' ? 'STORE' : 'DEFLATE';
}

/**
 * [custom] 회차 동시 처리 수 — 1=순차(기본). 2 이상이면 병렬.
 */
export function getConcurrency() {
    if (typeof GM_getValue === 'undefined') return 1;
    const v = parseInt(GM_getValue(CFG_CONCURRENCY, '1'), 10);
    if (!Number.isFinite(v) || v < 1) return 1;
    return Math.min(v, 8); // 최대 8 — 사이트 부하 보호
}

/**
 * [custom] 스크롤 대기 timeout (ms) — viewerCfg.scrollStallTimeoutMs 가 우선
 */
export function getScrollTimeoutMs() {
    if (typeof GM_getValue === 'undefined') return 20000;
    const v = parseInt(GM_getValue(CFG_SCROLL_TIMEOUT_MS, '20000'), 10);
    if (!Number.isFinite(v) || v < 1000) return 20000;
    return v;
}

/**
 * [custom] 전역 URL 차단 패턴 — 모든 룰에 적용
 * 쉼표 또는 줄바꿈으로 구분된 substring/regex 패턴
 */
export function getGlobalUrlExcludeList() {
    if (typeof GM_getValue === 'undefined') return [];
    const raw = GM_getValue(CFG_GLOBAL_URL_EXCLUDE, "");
    if (!raw || !raw.trim()) return [];
    return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Get current configuration
 * @returns {{gasId: string, gasUrl: string, folderId: string, policy: string, apiKey: string, sleepMode: string, smartSkipRatio: number}}
 */
export function getConfig() {
    let gasId = GM_getValue(CFG_ID_KEY, "");
    let gasUrl = GM_getValue(CFG_URL_KEY, "");

    // Auto-migration: gasUrl -> gasId
    if (!gasId && gasUrl) {
        const match = gasUrl.match(/\/s\/([^\/]+)\/exec/);
        if (match) {
            gasId = match[1];
            GM_setValue(CFG_ID_KEY, gasId);
            console.log("✅ [Config] Auto-migrated GAS URL to ID:", gasId);
        }
    }

    const finalGasId = gasId;
    // URL fallback for legacy or reconstructed from ID
    const finalGasUrl = finalGasId 
        ? `https://script.google.com/macros/s/${finalGasId}/exec` 
        : gasUrl;

    let remoteRuleUrl = GM_getValue(CFG_REMOTE_RULE_URL, "");
    if (!remoteRuleUrl || remoteRuleUrl.trim() === "") {
        remoteRuleUrl = "https://pray4skylark.github.io/tokiSync/rules.json";
    }

    return {
        gasId: finalGasId,
        gasUrl: finalGasUrl,
        folderId: GM_getValue(CFG_FOLDER_ID, ""),
        policy: GM_getValue(CFG_POLICY_KEY, "folderInCbz"),
        apiKey: GM_getValue(CFG_API_KEY, ""),
        sleepMode: GM_getValue(CFG_SLEEP_MODE, "agile"), // default: agile
        smartSkipRatio: parseInt(GM_getValue(CFG_SMART_SKIP_RATIO, "50"), 10), // default 50% of Max
        novelMode: GM_getValue(CFG_NOVEL_MODE, "perChapter"), // default: chapter-by-chapter
        novelFormat: GM_getValue(CFG_NOVEL_FORMAT, "epub"), // default: EPUB
        remoteRuleUrl: remoteRuleUrl,
        customRules: GM_getValue(CFG_CUSTOM_RULES, "[]"),
        webdavUrl: GM_getValue(CFG_WEBDAV_URL, ""),
        webdavUser: GM_getValue(CFG_WEBDAV_USER, ""),
        webdavPass: GM_getValue(CFG_WEBDAV_PASS, ""),
        concurrency: parseInt(GM_getValue(CFG_CONCURRENCY, "1"), 10) || 1,
        imgConcurrency: Math.min(16, Math.max(1, parseInt(GM_getValue(CFG_IMG_CONCURRENCY, "8"), 10) || 8)),
        wafJitterSec: Math.min(10, Math.max(0, parseFloat(GM_getValue(CFG_WAF_JITTER_SEC, "3")) || 3)),
        forceOpenShadow: GM_getValue(CFG_FORCE_OPEN_SHADOW, false) === true || GM_getValue(CFG_FORCE_OPEN_SHADOW, false) === '1'
    };
}

/**
 * 원격 제어 설정 조회
 * @returns {{enabled: boolean, url: string, token: string, pollSec: number}}
 */
export function getRemoteConfig() {
    const gv = (k, d) => {
        try { return typeof GM_getValue !== 'undefined' ? GM_getValue(k, d) : d; }
        catch { return d; }
    };
    return {
        enabled: gv(CFG_REMOTE_ENABLED, '0') === '1',
        url: gv(CFG_REMOTE_API_URL, ''),
        token: gv(CFG_REMOTE_API_TOKEN, ''),
        pollSec: Math.max(2, parseInt(gv(CFG_REMOTE_POLL_SEC, '5'), 10) || 5),
        clientId: (gv(CFG_REMOTE_CLIENT_ID, '') || '').trim(), // 설정 시 lease 모드, 빈값이면 레거시 /queue 모드
        leaseMax: Math.max(1, Math.min(20, parseInt(gv(CFG_REMOTE_LEASE_MAX, '2'), 10) || 2)),
    };
}

/**
 * Set configuration value
 * @param {string} key
 * @param {string} value
 */
export function setConfig(key, value) {
    GM_setValue(key, value);
}

/**
 * Show Configuration Modal
 */
export function showConfigModal() {
    // Remove existing modal if any
    const existing = document.getElementById('dsx-config-modal');
    if (existing) existing.remove();

    const config = getConfig();

    // -- HTML Structure (v1.9.1 Glassmorphism) --
    const overlay = document.createElement('div');
    overlay.id = 'dsx-config-modal';
    overlay.className = 'dsx-modal-overlay';
    

    overlay.innerHTML = `
        <div class="dsx-modal dsx-modal-main">
            <div class="dsx-modal-header dsx-modal-header-borderless">
                <div class="dsx-modal-title dsx-text-lg">🛠️ 상세 설정 (Advanced)</div>
            </div>
            
            <div class="dsx-section-title dsx-mt-0">Cloud & Storage</div>
            <div class="dsx-control-group">
                <label class="dsx-label">GAS Script ID</label>
                <input type="text" id="dsx-cfg-gas-id" class="dsx-input" placeholder="AKfycb..." value="${config.gasId}">
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">Google Drive Folder ID</label>
                <input type="text" id="dsx-cfg-folder" class="dsx-input" placeholder="Folder ID" value="${config.folderId}">
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">API Key (보안)</label>
                <input type="password" id="dsx-cfg-apikey" class="dsx-input" placeholder="API Key" value="${config.apiKey}">
            </div>

            <div class="dsx-section-title">NAS WebDAV (자동 분류 정책)</div>
            <div class="dsx-control-group">
                <label class="dsx-label">WebDAV URL</label>
                <input type="text" id="dsx-cfg-webdav-url" class="dsx-input" placeholder="http://192.168.0.50:5005/books" value="${config.webdavUrl}">
            </div>
            <div class="dsx-form-grid">
                <div class="dsx-control-group">
                    <label class="dsx-label">WebDAV 계정</label>
                    <input type="text" id="dsx-cfg-webdav-user" class="dsx-input" placeholder="user" value="${config.webdavUser}">
                </div>
                <div class="dsx-control-group">
                    <label class="dsx-label">WebDAV 비밀번호</label>
                    <input type="password" id="dsx-cfg-webdav-pass" class="dsx-input" placeholder="password" value="${config.webdavPass}">
                </div>
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label">동시 업로드 수 (1~8, 다운로드는 항상 순차)</label>
                <input type="number" id="dsx-cfg-concurrency" class="dsx-input" min="1" max="8" step="1" placeholder="1" value="${config.concurrency}">
            </div>

            <div class="dsx-section-title">다운로드 속도 (밴 위험 주의)</div>
            <div class="dsx-form-grid">
                <div class="dsx-control-group">
                    <label class="dsx-label">이미지 동시 다운로드 (1~16, 기본 8)</label>
                    <input type="number" id="dsx-cfg-img-concurrency" class="dsx-input" min="1" max="16" step="1" placeholder="8" value="${config.imgConcurrency}">
                </div>
                <div class="dsx-control-group">
                    <label class="dsx-label">WAF 지터 기준초 (기본 3 → 3~5초, 낮출수록 빠르지만 밴↑)</label>
                    <input type="number" id="dsx-cfg-waf-jitter" class="dsx-input" min="0" max="10" step="0.5" placeholder="3" value="${config.wafJitterSec}">
                </div>
            </div>
            <div class="dsx-control-group">
                <label class="dsx-label" style="display:flex;align-items:center;gap:8px;">
                    <input type="checkbox" id="dsx-cfg-force-shadow" ${config.forceOpenShadow ? 'checked' : ''}>
                    닫힌 Shadow DOM 강제 열기 (모든 사이트 강제 ON)
                </label>
                <small style="opacity:.6">소설(/novel/) 페이지는 자동으로 켜지므로 보통 끈 채로 두세요. URL이 /novel/이 아닌 소설 사이트에서만 수동으로 켜세요. (만화에서 강제 ON 시 차단 위험)</small>
            </div>

            <div class="dsx-section-title">Global Policies</div>
            <div class="dsx-control-group">
                <label class="dsx-label">다운로드 정책</label>
                <select id="dsx-cfg-policy" class="dsx-select">
                    <option value="individual">개별 파일 (Individual)</option>
                    <option value="zipOfCbzs">챕터 묶음 (ZIP of CBZs)</option>
                    <option value="native">자동 분류 (NAS WebDAV)</option>
                    <option value="drive">드라이브 업로드 (GoogleDrive)</option>
                </select>
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">다운로드 속도</label>
                <select id="dsx-cfg-sleepmode" class="dsx-select">
                    <option value="agile">빠름 (1-3초)</option>
                    <option value="cautious">신중 (2-5초)</option>
                    <option value="thorough">철저 (3-8초)</option>
                    <option value="slow">느림 (5-15초)</option>
                    <option value="very_slow">매우 느림 (10-30초)</option>
                </select>
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">Smart Skip 민감도</label>
                <select id="dsx-cfg-smartskip" class="dsx-select">
                    <option value="90">90% (매우 민감)</option>
                    <option value="80">80% (민감)</option>
                    <option value="70">70% (보통)</option>
                    <option value="50">50% (기본)</option>
                </select>
            </div>
            
            <div class="dsx-section-title">Format & Rules</div>
            <div class="dsx-form-grid">
                <div class="dsx-control-group">
                    <label class="dsx-label">소설 포맷</label>
                    <select id="dsx-cfg-novel-format" class="dsx-select">
                        <option value="epub">EPUB</option>
                        <option value="txt">TXT</option>
                    </select>
                </div>
                <div class="dsx-control-group">
                    <label class="dsx-label">소설 패키징</label>
                    <select id="dsx-cfg-novel-mode" class="dsx-select">
                        <option value="perChapter">개별 회차</option>
                        <option value="singleVolume">범위 합본</option>
                    </select>
                </div>
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">원격 파싱 룰 URL (JSON)</label>
                <input type="text" id="dsx-cfg-remote-rule" class="dsx-input" placeholder="https://example.com/rules.json" value="${config.remoteRuleUrl}">
            </div>

            <div class="dsx-control-group">
                <label class="dsx-label">커스텀 파싱 룰 (JSON Array)</label>
                <textarea id="dsx-cfg-custom-rule" class="dsx-textarea dsx-textarea-code" placeholder="[{...}]">${config.customRules}</textarea>
            </div>

            <div class="dsx-modal-footer dsx-btn-group-row dsx-mt-32">
                <button id="dsx-btn-cancel" class="dsx-btn-action dsx-btn-secondary">취소</button>
                <button id="dsx-btn-save" class="dsx-btn-action">설정 저장하기</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // -- Logic --
    const policySelect = document.getElementById('dsx-cfg-policy');
    if(policySelect) policySelect.value = config.policy;
    
    const sleepModeSelect = document.getElementById('dsx-cfg-sleepmode');
    if(sleepModeSelect) sleepModeSelect.value = config.sleepMode;

    const smartSkipSelect = document.getElementById('dsx-cfg-smartskip');
    if(smartSkipSelect) smartSkipSelect.value = config.smartSkipRatio;

    const novelModeSelect = document.getElementById('dsx-cfg-novel-mode');
    if(novelModeSelect) novelModeSelect.value = config.novelMode;

    const novelFormatSelect = document.getElementById('dsx-cfg-novel-format');
    if(novelFormatSelect) novelFormatSelect.value = config.novelFormat;

    document.getElementById('dsx-btn-cancel').onclick = () => overlay.remove();
    
    document.getElementById('dsx-btn-save').onclick = () => {
        const newGasId = document.getElementById('dsx-cfg-gas-id').value.trim();
        const newFolder = document.getElementById('dsx-cfg-folder').value.trim();
        const newApiKey = document.getElementById('dsx-cfg-apikey').value.trim();
        const newPolicy = document.getElementById('dsx-cfg-policy').value;
        const newSleepMode = document.getElementById('dsx-cfg-sleepmode').value;
        const newSmartSkip = document.getElementById('dsx-cfg-smartskip').value;
        const newNovelMode = document.getElementById('dsx-cfg-novel-mode').value;
        const newNovelFormat = document.getElementById('dsx-cfg-novel-format').value;
        const newRemoteRule = document.getElementById('dsx-cfg-remote-rule').value.trim();
        const newCustomRule = document.getElementById('dsx-cfg-custom-rule').value.trim() || '[]';
        const newWebdavUrl = document.getElementById('dsx-cfg-webdav-url').value.trim();
        const newWebdavUser = document.getElementById('dsx-cfg-webdav-user').value.trim();
        const newWebdavPass = document.getElementById('dsx-cfg-webdav-pass').value;
        let newConcurrency = parseInt(document.getElementById('dsx-cfg-concurrency').value, 10);
        if (!Number.isFinite(newConcurrency) || newConcurrency < 1) newConcurrency = 1;
        if (newConcurrency > 8) newConcurrency = 8;
        let newImgConc = parseInt(document.getElementById('dsx-cfg-img-concurrency').value, 10);
        if (!Number.isFinite(newImgConc) || newImgConc < 1) newImgConc = 8;
        if (newImgConc > 16) newImgConc = 16;
        let newWafJitter = parseFloat(document.getElementById('dsx-cfg-waf-jitter').value);
        if (!Number.isFinite(newWafJitter) || newWafJitter < 0) newWafJitter = 3;
        if (newWafJitter > 10) newWafJitter = 10;
        const newForceShadow = !!document.getElementById('dsx-cfg-force-shadow')?.checked;

        // Validate Custom Rules JSON
        let validCustomRule = '[]';
        try {
            let parsed = JSON.parse(newCustomRule);
            
            // [v1.8.1] 룰 구조 유연화: { rules: [...] } 형태의 전체 구조를 넣었을 경우 자동 처리
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                if (Array.isArray(parsed.rules)) {
                    parsed = parsed.rules;
                } else {
                    throw new Error("커스텀 룰은 JSON 배열이거나, 'rules' 키를 포함한 객체여야 합니다.");
                }
            }

            if (!Array.isArray(parsed)) {
                throw new Error("커스텀 룰은 JSON 배열(Array) 형태여야 합니다.");
            }
            validCustomRule = JSON.stringify(parsed, null, 2);
        } catch (e) {
            tokiAlert(`커스텀 룰 JSON 파싱 오류:\n${e.message}\n설정을 저장할 수 없습니다.`);
            return;
        }

        // URL 입력 시 ID 추출 로직 병합 (사용자 편의성)
        let finalGasId = newGasId;
        const urlMatch = newGasId.match(/\/s\/([^\/]+)\/exec/);
        if (urlMatch) finalGasId = urlMatch[1];

        setConfig(CFG_ID_KEY, finalGasId);
        setConfig(CFG_FOLDER_ID, newFolder);
        setConfig(CFG_API_KEY, newApiKey);
        setConfig(CFG_POLICY_KEY, newPolicy);
        setConfig(CFG_SLEEP_MODE, newSleepMode);
        setConfig(CFG_SMART_SKIP_RATIO, newSmartSkip);
        setConfig(CFG_NOVEL_MODE, newNovelMode);
        setConfig(CFG_NOVEL_FORMAT, newNovelFormat);
        setConfig(CFG_REMOTE_RULE_URL, newRemoteRule);
        setConfig(CFG_CUSTOM_RULES, validCustomRule);
        setConfig(CFG_WEBDAV_URL, newWebdavUrl);
        setConfig(CFG_WEBDAV_USER, newWebdavUser);
        setConfig(CFG_WEBDAV_PASS, newWebdavPass);
        setConfig(CFG_CONCURRENCY, String(newConcurrency));
        setConfig(CFG_IMG_CONCURRENCY, String(newImgConc));
        setConfig(CFG_WAF_JITTER_SEC, String(newWafJitter));
        setConfig(CFG_FORCE_OPEN_SHADOW, newForceShadow); // boolean — index.js 워커가 truthy 체크

        tokiAlert('설정이 저장되었습니다.');
        overlay.remove();
    };


    // Close on background click
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };
}

/**
 * Check if configuration is valid
 * @returns {boolean}
 */
export function isConfigValid() {
    const config = getConfig();
    return (config.gasId || config.gasUrl) && config.folderId;
}