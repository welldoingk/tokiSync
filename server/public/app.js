/* tokiSync 원격 제어 대시보드 — vanilla JS */
(function () {
    'use strict';

    const LS = {
        base: 'toki.base',
        token: 'toki.token',
        poll: 'toki.poll',
    };

    const $ = (id) => document.getElementById(id);
    let pollTimer = null;

    function getBase() {
        const b = (localStorage.getItem(LS.base) || '').trim().replace(/\/+$/, '');
        return b || ''; // 빈 값 = 같은 오리진(상대 경로)
    }
    function getToken() {
        return (localStorage.getItem(LS.token) || '').trim();
    }
    function getPollSec() {
        return Math.max(2, parseInt(localStorage.getItem(LS.poll) || '3', 10) || 3);
    }

    function api(path, opts = {}) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        const token = getToken();
        if (token) headers['X-Toki-Token'] = token;
        return fetch(getBase() + path, {
            method: opts.method || 'GET',
            headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        }).then(async (r) => {
            const text = await r.text();
            let json = {};
            try { json = text ? JSON.parse(text) : {}; } catch (_) {}
            if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
            return json;
        });
    }

    function toast(msg) {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove('show'), 1800);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
        );
    }

    function fmtTime(ts) {
        if (!ts) return '-';
        try { return new Date(ts).toLocaleTimeString('ko-KR'); } catch (_) { return '-'; }
    }

    function statusIcon(s) {
        return s === 'done' ? '✅' : s === 'error' ? '❌' : '⏳';
    }

    function renderQueue(report) {
        const q = (report && report.queue) || [];
        $('q-count').textContent = q.length;
        const box = $('queue');
        if (!q.length) {
            box.innerHTML = '<div class="empty">큐가 비어 있습니다.</div>';
            return;
        }
        box.innerHTML = q
            .map((it) => {
                const label = it.title || it.url;
                return `<div class="q-item">
                    <span class="q-ic">${statusIcon(it.status)}</span>
                    <span class="q-title"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(label)}</a>
                        ${it.error ? `<small>${esc(it.error)}</small>` : ''}</span>
                    <button class="small danger" data-url="${esc(it.url)}">✕</button>
                </div>`;
            })
            .join('');
        box.querySelectorAll('button[data-url]').forEach((b) => {
            b.onclick = () => removeUrl(b.dataset.url);
        });
    }

    function renderCaptcha(list) {
        const panel = $('captcha-panel');
        const box = $('captcha');
        if (!list || !list.length) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';
        box.innerHTML = list
            .slice(-5)
            .reverse()
            .map(
                (c) => `<div class="captcha-item">
                    <span class="t">${fmtTime(c.ts)}</span>
                    <span class="m">${esc(c.message)}${c.url ? `<br><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>` : ''}</span>
                </div>`
            )
            .join('');
    }

    function renderProgress(report, online) {
        const p = report && report.progress;
        const parts = [];
        if (p && typeof p === 'object') {
            if (p.pos && p.total) parts.push(`회차/시리즈 ${esc(p.pos)}/${esc(p.total)}`);
            if (p.phase) parts.push(esc(p.phase));
            if (p.url) parts.push(esc(p.url));
        }
        const last = report && report.ts ? `마지막 보고 ${fmtTime(report.ts)}` : '보고 없음';
        $('progress').textContent = (parts.length ? parts.join(' · ') + ' — ' : '') + last;
    }

    function setPills(online, running) {
        const po = $('pill-online');
        po.textContent = online ? '스크립트 온라인' : '스크립트 오프라인';
        po.className = 'pill ' + (online ? 'on' : 'off');
        const pr = $('pill-running');
        pr.textContent = running ? '실행 중' : '정지';
        pr.className = 'pill ' + (running ? 'run' : '');
    }

    async function refresh() {
        try {
            const data = await api('/queue');
            const report = data.report || {};
            setPills(!!data.online, !!report.running);
            renderQueue(report);
            renderCaptcha(data.captcha);
            renderProgress(report, data.online);
            $('footer').textContent = `서버 시각 ${fmtTime(data.serverTime)} · seq ${data.seq}`;
            $('conn-info').textContent = `연결됨: ${getBase() || location.origin}`;
        } catch (e) {
            setPills(false, false);
            $('footer').textContent = `연결 실패: ${e.message}`;
        }
    }

    async function addUrls() {
        const text = $('urls').value;
        if (!text.trim()) return toast('URL을 입력하세요');
        try {
            const r = await api('/queue', { method: 'POST', body: { urls: text } });
            $('urls').value = '';
            toast(`${r.count}개 추가됨`);
            refresh();
        } catch (e) {
            toast('추가 실패: ' + e.message);
        }
    }

    async function cmd(path, label) {
        try {
            await api(path, { method: 'POST' });
            toast(label);
            refresh();
        } catch (e) {
            toast('실패: ' + e.message);
        }
    }

    async function removeUrl(url) {
        try {
            await api('/queue/remove', { method: 'POST', body: { url } });
            toast('제거 명령 전송');
            refresh();
        } catch (e) {
            toast('실패: ' + e.message);
        }
    }

    function loadSettings() {
        $('set-base').value = localStorage.getItem(LS.base) || '';
        $('set-token').value = localStorage.getItem(LS.token) || '';
        $('set-poll').value = getPollSec();
    }

    function saveSettings() {
        localStorage.setItem(LS.base, $('set-base').value.trim());
        localStorage.setItem(LS.token, $('set-token').value.trim());
        localStorage.setItem(LS.poll, String(Math.max(2, parseInt($('set-poll').value, 10) || 3)));
        toast('저장됨');
        startPolling();
        refresh();
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(refresh, getPollSec() * 1000);
    }

    function init() {
        loadSettings();
        $('btn-add').onclick = addUrls;
        $('btn-start').onclick = () => cmd('/queue/start', '시작 명령 전송');
        $('btn-stop').onclick = () => cmd('/queue/stop', '정지 명령 전송');
        $('btn-clear').onclick = () => {
            if (confirm('큐를 비울까요?')) cmd('/queue/clear', '비우기 명령 전송');
        };
        $('btn-save').onclick = saveSettings;
        refresh();
        startPolling();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
