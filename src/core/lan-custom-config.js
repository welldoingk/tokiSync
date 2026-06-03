export const CFG_REMOTE_RULE_URL = "TOKI_REMOTE_RULE_URL";
export const CFG_CUSTOM_RULES = "TOKI_CUSTOM_RULES";
export const CFG_WEBDAV_URL = "TOKI_WEBDAV_URL";
export const CFG_WEBDAV_USER = "TOKI_WEBDAV_USER";
export const CFG_WEBDAV_PASS = "TOKI_WEBDAV_PASS";
export const CFG_REMOTE_ENABLED = "TOKI_REMOTE_ENABLED";
export const CFG_REMOTE_API_URL = "TOKI_REMOTE_API_URL";
export const CFG_REMOTE_API_TOKEN = "TOKI_REMOTE_API_TOKEN";
export const CFG_REMOTE_POLL_SEC = "TOKI_REMOTE_POLL_SEC";
export const CFG_REMOTE_CLIENT_ID = "TOKI_REMOTE_CLIENT_ID";
export const CFG_REMOTE_LEASE_MAX = "TOKI_REMOTE_LEASE_MAX";
export const CFG_SCAN_SPEED = "TOKI_SCAN_SPEED";
export const CFG_LOCAL_NAME_TEMPLATE = "TOKI_LOCAL_NAME_TEMPLATE";
export const CFG_LOCAL_EPISODE_PADDING = "TOKI_LOCAL_EPISODE_PADDING";

export const DEFAULT_REMOTE_RULE_URL = "https://pray4skylark.github.io/tokiSync/rules.json";

export function normalizeScanSpeed(value) {
    let val = parseFloat(value);
    if (!Number.isFinite(val)) val = 1000;
    if (val <= 10) val *= 1000;
    return Math.round(val);
}

export function normalizeRemoteRuleUrl(value) {
    const url = (value || '').trim();
    return url || DEFAULT_REMOTE_RULE_URL;
}

export function getLanConfigValues(getValue) {
    const remoteRuleUrl = normalizeRemoteRuleUrl(getValue(CFG_REMOTE_RULE_URL, ""));
    return {
        remoteRuleUrl,
        customRules: getValue(CFG_CUSTOM_RULES, "[]"),
        webdavUrl: getValue(CFG_WEBDAV_URL, ""),
        webdavUser: getValue(CFG_WEBDAV_USER, ""),
        webdavPass: getValue(CFG_WEBDAV_PASS, ""),
        scanSpeed: normalizeScanSpeed(getValue(CFG_SCAN_SPEED, "1000")),
        localNameTemplate: getValue(CFG_LOCAL_NAME_TEMPLATE, "{number} - {title}"),
        localEpisodePadding: getValue(CFG_LOCAL_EPISODE_PADDING, "4")
    };
}

export function getRemoteConfigFromStore(getValue) {
    const gv = (key, fallback) => {
        try { return typeof getValue === 'function' ? getValue(key, fallback) : fallback; }
        catch { return fallback; }
    };
    return {
        enabled: gv(CFG_REMOTE_ENABLED, '0') === '1',
        url: gv(CFG_REMOTE_API_URL, ''),
        token: gv(CFG_REMOTE_API_TOKEN, ''),
        pollSec: Math.max(2, parseInt(gv(CFG_REMOTE_POLL_SEC, '5'), 10) || 5),
        clientId: (gv(CFG_REMOTE_CLIENT_ID, '') || '').trim(),
        leaseMax: Math.max(1, Math.min(20, parseInt(gv(CFG_REMOTE_LEASE_MAX, '2'), 10) || 2)),
    };
}

export function parseCustomRulesJson(rawValue) {
    let parsed = JSON.parse((rawValue || '').trim() || '[]');
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
    return JSON.stringify(parsed, null, 2);
}
