import {
    CFG_API_KEY,
    CFG_CUSTOM_RULES,
    CFG_FOLDER_ID,
    CFG_LOCAL_EPISODE_PADDING,
    CFG_LOCAL_NAME_TEMPLATE,
    CFG_NOVEL_FORMAT,
    CFG_NOVEL_MODE,
    CFG_POLICY_KEY,
    CFG_REMOTE_API_TOKEN,
    CFG_REMOTE_API_URL,
    CFG_REMOTE_CLIENT_ID,
    CFG_REMOTE_ENABLED,
    CFG_REMOTE_LEASE_MAX,
    CFG_REMOTE_POLL_SEC,
    CFG_REMOTE_RULE_URL,
    CFG_SCAN_SPEED,
    CFG_SLEEP_MODE,
    CFG_SMART_SKIP_RATIO,
    CFG_WEBDAV_PASS,
    CFG_WEBDAV_URL,
    CFG_WEBDAV_USER,
    CFG_ID_KEY
} from './config.js';
import { parseCustomRulesJson } from './lan-custom-config.js';

export function renderLanDashboardSettingsHtml() {
    return `
                    <div class="toki-section-title">NAS WebDAV</div>
                    <div class="toki-control-group">
                        <label class="toki-label">WebDAV URL</label>
                        <input type="text" id="toki-sel-webdav-url" class="toki-input" placeholder="http://192.168.0.50:5005/books">
                    </div>
                    <div class="toki-control-group">
                        <label class="toki-label">WebDAV 사용자</label>
                        <input type="text" id="toki-sel-webdav-user" class="toki-input" placeholder="user">
                    </div>
                    <div class="toki-control-group">
                        <label class="toki-label">WebDAV 비밀번호 (보안)</label>
                        <input type="password" id="toki-sel-webdav-pass" class="toki-input" placeholder="••••">
                    </div>

                    <div class="toki-section-title">원격 제어 (멀티-IP)</div>
                    <div class="toki-control-group">
                        <label class="toki-label">
                            <input type="checkbox" id="toki-sel-remote-enabled"> 원격 제어 활성화
                        </label>
                    </div>
                    <div class="toki-control-group">
                        <label class="toki-label">컨트롤 API URL</label>
                        <input type="text" id="toki-sel-remote-url" class="toki-input" placeholder="http://192.168.0.100:8787">
                    </div>
                    <div class="toki-control-group">
                        <label class="toki-label">API 토큰 (보안)</label>
                        <input type="password" id="toki-sel-remote-token" class="toki-input" placeholder="open 모드면 비움">
                    </div>
                    <div class="toki-form-grid">
                        <div class="toki-control-group">
                            <label class="toki-label">폴링 주기 (초)</label>
                            <input type="number" id="toki-sel-remote-poll" class="toki-input" min="2" placeholder="5">
                        </div>
                        <div class="toki-control-group">
                            <label class="toki-label">동시 보유 작업수 (leaseMax)</label>
                            <input type="number" id="toki-sel-remote-leasemax" class="toki-input" min="1" max="20" placeholder="2">
                        </div>
                    </div>
                    <div class="toki-control-group">
                        <label class="toki-label">클라이언트 ID</label>
                        <input type="text" id="toki-sel-remote-clientid" class="toki-input" placeholder="A-direct / B-vpn">
                    </div>`;
}

export function renderLanRuleSettingsHtml() {
    return `
                    <div class="toki-control-group">
                        <label class="toki-label">원격 파싱 룰 URL (JSON)</label>
                        <input type="text" id="toki-sel-remote-rule" class="toki-input" placeholder="https://example.com/rules.json">
                    </div>

                    <div class="toki-control-group">
                        <label class="toki-label">커스텀 파싱 룰 (JSON Array)</label>
                        <textarea id="toki-sel-custom-rule" class="toki-textarea toki-textarea-code" placeholder="[{...}]" style="min-height: 100px;"></textarea>
                    </div>`;
}

export function getLanSettingsElements(doc) {
    const byId = (id) => doc.getElementById(id);
    return {
        remoteRule: byId('toki-sel-remote-rule'),
        customRule: byId('toki-sel-custom-rule'),
        webdavUrl: byId('toki-sel-webdav-url'),
        webdavUser: byId('toki-sel-webdav-user'),
        webdavPass: byId('toki-sel-webdav-pass'),
        remoteEnabled: byId('toki-sel-remote-enabled'),
        remoteUrl: byId('toki-sel-remote-url'),
        remoteToken: byId('toki-sel-remote-token'),
        remotePoll: byId('toki-sel-remote-poll'),
        remoteClientId: byId('toki-sel-remote-clientid'),
        remoteLeaseMax: byId('toki-sel-remote-leasemax')
    };
}

export function populateLanSettings(els, cfg, remoteCfg) {
    if (els.remoteRule) els.remoteRule.value = cfg.remoteRuleUrl || '';
    if (els.customRule) els.customRule.value = cfg.customRules || '';
    if (els.webdavUrl) els.webdavUrl.value = cfg.webdavUrl || '';
    if (els.webdavUser) els.webdavUser.value = cfg.webdavUser || '';
    if (els.webdavPass) els.webdavPass.value = cfg.webdavPass || '';
    if (els.remoteEnabled) els.remoteEnabled.checked = !!remoteCfg.enabled;
    if (els.remoteUrl) els.remoteUrl.value = remoteCfg.url || '';
    if (els.remoteToken) els.remoteToken.value = remoteCfg.token || '';
    if (els.remotePoll) els.remotePoll.value = String(remoteCfg.pollSec);
    if (els.remoteClientId) els.remoteClientId.value = remoteCfg.clientId || '';
    if (els.remoteLeaseMax) els.remoteLeaseMax.value = String(remoteCfg.leaseMax);
}

export function bindLanSettingsAutoSave(els, saveCfg) {
    if (els.webdavUrl) els.webdavUrl.onchange = () => saveCfg(CFG_WEBDAV_URL, els.webdavUrl.value.trim());
    if (els.webdavUser) els.webdavUser.onchange = () => saveCfg(CFG_WEBDAV_USER, els.webdavUser.value);
    if (els.webdavPass) els.webdavPass.onchange = () => saveCfg(CFG_WEBDAV_PASS, els.webdavPass.value);
    if (els.remoteEnabled) els.remoteEnabled.onchange = () => saveCfg(CFG_REMOTE_ENABLED, els.remoteEnabled.checked ? '1' : '0');
    if (els.remoteUrl) els.remoteUrl.onchange = () => saveCfg(CFG_REMOTE_API_URL, els.remoteUrl.value.trim());
    if (els.remoteToken) els.remoteToken.onchange = () => saveCfg(CFG_REMOTE_API_TOKEN, els.remoteToken.value);
    if (els.remotePoll) els.remotePoll.onchange = () => saveCfg(CFG_REMOTE_POLL_SEC, els.remotePoll.value);
    if (els.remoteClientId) els.remoteClientId.onchange = () => saveCfg(CFG_REMOTE_CLIENT_ID, els.remoteClientId.value.trim());
    if (els.remoteLeaseMax) els.remoteLeaseMax.onchange = () => saveCfg(CFG_REMOTE_LEASE_MAX, els.remoteLeaseMax.value);
}

export function saveDashboardSettings(values, els, saveCfg, alertFn) {
    let validCustomRule = '[]';
    try {
        validCustomRule = parseCustomRulesJson(els.customRule ? els.customRule.value : '[]');
    } catch (err) {
        alertFn(`커스텀 룰 JSON 파싱 오류:\n${err.message}\n설정을 저장할 수 없습니다.`);
        return false;
    }

    const gasId = (values.gasId || '').trim();
    const urlMatch = gasId.match(/\/s\/([^\/]+)\/exec/);
    saveCfg(CFG_ID_KEY, urlMatch ? urlMatch[1] : gasId);
    saveCfg(CFG_FOLDER_ID, (values.folderId || '').trim());
    saveCfg(CFG_API_KEY, (values.apiKey || '').trim());
    saveCfg(CFG_POLICY_KEY, values.policy || 'individual');
    saveCfg(CFG_LOCAL_NAME_TEMPLATE, (values.localNameTemplate || '').trim() || "{number} - {title}");
    saveCfg(CFG_LOCAL_EPISODE_PADDING, values.localEpisodePadding || '4');
    saveCfg(CFG_SLEEP_MODE, values.sleepMode || 'agile');
    saveCfg(CFG_SCAN_SPEED, values.scanSpeed || '1000');
    saveCfg(CFG_NOVEL_FORMAT, values.novelFormat || 'epub');
    saveCfg(CFG_NOVEL_MODE, values.novelMode || 'perChapter');
    saveCfg(CFG_SMART_SKIP_RATIO, values.smartSkipRatio || '50');
    saveCfg(CFG_REMOTE_RULE_URL, els.remoteRule ? els.remoteRule.value.trim() : '');
    saveCfg(CFG_CUSTOM_RULES, validCustomRule);
    saveCfg(CFG_WEBDAV_URL, els.webdavUrl ? els.webdavUrl.value.trim() : '');
    saveCfg(CFG_WEBDAV_USER, els.webdavUser ? els.webdavUser.value : '');
    saveCfg(CFG_WEBDAV_PASS, els.webdavPass ? els.webdavPass.value : '');
    saveCfg(CFG_REMOTE_ENABLED, els.remoteEnabled && els.remoteEnabled.checked ? '1' : '0');
    saveCfg(CFG_REMOTE_API_URL, els.remoteUrl ? els.remoteUrl.value.trim() : '');
    saveCfg(CFG_REMOTE_API_TOKEN, els.remoteToken ? els.remoteToken.value : '');
    saveCfg(CFG_REMOTE_POLL_SEC, els.remotePoll ? els.remotePoll.value : '5');
    saveCfg(CFG_REMOTE_CLIENT_ID, els.remoteClientId ? els.remoteClientId.value.trim() : '');
    saveCfg(CFG_REMOTE_LEASE_MAX, els.remoteLeaseMax ? els.remoteLeaseMax.value : '2');
    return true;
}
