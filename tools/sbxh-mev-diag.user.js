// ==UserScript==
// @name         sbxh m/ev DIAG (anti-adblock 탐지 페이로드 캡처)
// @namespace    local://lan/tokisync-diag
// @version      0.1.0
// @description  sbxh/뉴토끼 계열의 /api/m/ev·/api/manhwa-images·/api/ad/challenge 요청/응답을 document-start에 네이티브 위장 후킹으로 localStorage에 덤프. 어느 탐지 플래그(userscript_spoof/slot_hide_any/brokenImages 등)가 발동하는지 확인용. 진단 전용 — 평소엔 비활성화.
// @author       local
// @match        *://sbxh3.com/*
// @match        *://*/*manhwa/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    var KEY = '__diag_mev';
    var MAX = 60;

    function push(entry) {
        try {
            var arr = JSON.parse(localStorage.getItem(KEY) || '[]');
            arr.push(entry);
            if (arr.length > MAX) arr.splice(0, arr.length - MAX);
            localStorage.setItem(KEY, JSON.stringify(arr));
        } catch (e) {}
    }

    function interesting(u) {
        return /\/api\/(m\/ev|ad\/challenge|manhwa-images|dev-block)/.test(u || '');
    }

    // 본문 직렬화 (문자열/Blob/ArrayBuffer/FormData 대응). Blob/ArrayBuffer는 비동기로 읽어 rec에 채운 뒤 push.
    function clipInto(rec, field, body, done) {
        try {
            if (body == null) { rec[field] = null; return done(); }
            if (typeof body === 'string') { rec[field] = body.slice(0, 6000); return done(); }
            if (body instanceof Blob) {
                body.text().then(function (t) { rec[field] = String(t).slice(0, 6000); done(); }).catch(function () { rec[field] = '[blob ' + body.size + ']'; done(); });
                return;
            }
            if (body instanceof ArrayBuffer) {
                try { rec[field] = new TextDecoder().decode(body).slice(0, 6000); } catch (e) { rec[field] = '[arraybuffer ' + body.byteLength + ']'; }
                return done();
            }
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                var o = {}; body.forEach(function (v, k) { o[k] = String(v).slice(0, 300); }); rec[field] = JSON.stringify(o).slice(0, 6000); return done();
            }
            rec[field] = JSON.stringify(body).slice(0, 6000);
            return done();
        } catch (e) { rec[field] = '[unserializable]'; return done(); }
    }

    // 래퍼를 네이티브처럼 위장 (Function.toString / .toString 둘 다)
    function mask(wrapper, original) {
        try {
            var nativeStr = Function.prototype.toString.call(original);
            wrapper.toString = function () { return nativeStr; };
            try {
                Object.defineProperty(wrapper, 'name', { value: original.name || '', configurable: true });
                Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true });
            } catch (e) {}
        } catch (e) {}
        return wrapper;
    }

    // ── fetch (페이로드 keys에 method/headers/body/keepalive 가 있으므로 /api/m/ev 는 fetch 추정) ──
    try {
        var of = window.fetch;
        if (of) {
            var wf = function (input, init) {
                var u = '';
                try { u = (typeof input === 'string' ? input : (input && input.url)) || ''; } catch (e) {}
                var p = of.apply(this, arguments);
                if (interesting(u)) {
                    var rec = { t: Date.now(), via: 'fetch', url: String(u).replace(location.origin, '') };
                    clipInto(rec, 'reqBody', init && init.body, function () {
                        try {
                            p.then(function (r) {
                                rec.status = r.status;
                                try { r.clone().text().then(function (t) { rec.respBody = String(t).slice(0, 2000); push(rec); }).catch(function () { push(rec); }); }
                                catch (e) { push(rec); }
                            }).catch(function (e) { rec.err = String(e); push(rec); });
                        } catch (e) { push(rec); }
                    });
                }
                return p;
            };
            window.fetch = mask(wf, of);
        }
    } catch (e) {}

    // ── XMLHttpRequest ──
    try {
        var oo = XMLHttpRequest.prototype.open;
        var oss = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = mask(function (m, u) { this.__du = u; this.__dm = m; return oo.apply(this, arguments); }, oo);
        XMLHttpRequest.prototype.send = mask(function (b) {
            var u = this.__du || '';
            if (interesting(u)) {
                var self = this;
                var rec = { t: Date.now(), via: 'xhr', method: this.__dm, url: String(u).replace(location.origin, '') };
                clipInto(rec, 'reqBody', b, function () {
                    self.addEventListener('loadend', function () {
                        try { rec.status = self.status; rec.respBody = String(self.responseText || '').slice(0, 2000); } catch (e) {}
                        push(rec);
                    });
                });
            }
            return oss.apply(this, arguments);
        }, oss);
    } catch (e) {}

    // ── navigator.sendBeacon ──
    try {
        if (navigator.sendBeacon) {
            var ob = navigator.sendBeacon;
            var wb = function (u, data) {
                if (interesting(u)) {
                    var rec = { t: Date.now(), via: 'beacon', url: String(u).replace(location.origin, '') };
                    clipInto(rec, 'reqBody', data, function () { push(rec); });
                }
                return ob.apply(navigator, arguments);
            };
            navigator.sendBeacon = mask(wb, ob);
        }
    } catch (e) {}

    // 덤프/초기화 헬퍼 (콘솔 또는 외부 도구에서 호출)
    window.__diagDump = function () { return localStorage.getItem(KEY) || '[]'; };
    window.__diagClear = function () { localStorage.removeItem(KEY); return 'cleared'; };
    try { console.log('[sbxh-diag] active v0.1.0 — capturing /api/m/ev etc. → localStorage["' + KEY + '"]'); } catch (e) {}
})();
