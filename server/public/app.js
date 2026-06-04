/* tokiSync 원격 제어 대시보드 — vanilla JS */
(function () {
    'use strict';

    const LS = {
        base: 'toki.base',
        token: 'toki.token',
        poll: 'toki.poll',
        theme: 'toki.theme',
        notify: 'toki.notify',
        wakelock: 'toki.wakelock',
        recent: 'toki.recent',
        logsel: 'toki.logsel',
        nasUrl: 'toki.nas.url',
        nasUser: 'toki.nas.user',
        nasPass: 'toki.nas.pass',
        nasCategory: 'toki.nas.category',
        nasRatio: 'toki.nas.ratio',
        nasSeries: 'toki.nas.series',
        nasUpdateUrl: 'toki.nas.updateUrl',
    };

    // 클라 버전 뱃지 기준 — 서버 /clients 의 latestClientVersion(docs/tokiSync.user.js @version)으로
    //   매 폴링마다 갱신된다. 아래는 서버값 수신 전 폴백(초기 1회용). 빌드하면 서버가 자동 최신값 제공.
    let _latestVer = '260601-11';
    function _parseVer(v) { const m = String(v || '').match(/(\d{6})-(\d+)/); return m ? { d: +m[1], n: +m[2] } : null; }
    function _isOldVer(v) {
        const c = _parseVer(v), L = _parseVer(_latestVer);
        if (!c || !L) return true;
        return c.d < L.d || (c.d === L.d && c.n < L.n);
    }

    const $ = (id) => document.getElementById(id);
    let pollTimer = null;

    // ── 편의 기능 상태 ──
    let _doneHist = [];          // [{t, done}] 슬라이딩 윈도우(ETA/속도 추정)
    let _prevActive = false;     // 직전 폴링에 작업이 진행 중이었나(전체 완료 엣지 알림용)
    let _prevCaptcha = -1;       // 직전 캡차 개수(증가 시 알림). -1 = 첫 로드(알림 안 함)
    let _leasedMap = {};         // clientId → [leased unit] (현재 처리 회차 표시용)
    let _wakeLock = null;        // Screen Wake Lock 센티넬
    let _audioCtx = null;        // 알림 비프용 (lazy)
    let _logSel = '';            // 실시간 로그 패널에서 선택된 clientId
    let _logSince = 0;           // 선택 클라의 마지막 수신 로그 seq(증분 커서)
    let _logWs = null;           // 로그 WebSocket(선택 클라 1개 구독)
    let _logWsReconnect = null;
    let _logWsNextAt = 0;
    let _logWsSubscribed = '';
    let _nasAudit = null;        // 최근 NAS 스캔 결과
    let _clientsCache = [];
    let _poolCache = null;
    let _liveTickTimer = null;

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

    function scriptUpdateUrl() {
        return `${getBase() || location.origin}/tokiSync.user.js`;
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

    function stageLabel(stage, status, percent) {
        if (status === 'pending') return '대기';
        if (status === 'failed') return '실패';
        if (status === 'completed') return '완료';
        const map = {
            STAGE_INIT: '초기화',
            STAGE_DOM_READY: '페이지 로딩',
            STAGE_SCROLLING: '스크롤 스캔',
            STAGE_PARSING: '미디어 파싱',
            STAGE_DOWNLOADING: '다운로드',
            STAGE_UPLOADING: '저장',
            STAGE_COMPLETED: '완료',
            STAGE_FAILED: '실패',
        };
        if (map[stage]) return map[stage];
        const pct = Number(percent);
        if (status === 'processing' && Number.isFinite(pct)) {
            if (pct >= 90) return '저장';
            if (pct >= 85) return '미디어 파싱';
            if (pct === 40) return '스크롤 스캔';
            if (pct >= 10 && pct <= 30) return '페이지 로딩';
            if (pct > 0) return '다운로드';
        }
        return status === 'processing' ? '실행 중' : '';
    }

    const PROGRESS_STEPS = [
        { k: 'load', label: '페이지 로딩' },
        { k: 'scroll', label: '스크롤 스캔' },
        { k: 'download', label: '다운로드' },
        { k: 'parse', label: '미디어 파싱' },
        { k: 'save', label: 'NAS 저장' },
        { k: 'done', label: '완료' },
    ];

    function clampPercent(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(100, Math.round(n)));
    }

    function clip(s, max = 70) {
        const text = String(s == null ? '' : s);
        return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }

    function fmtShortDuration(ms) {
        const n = Number(ms);
        if (!Number.isFinite(n) || n < 0) return '';
        const sec = Math.floor(n / 1000);
        if (sec < 60) return sec + '초';
        const min = Math.floor(sec / 60);
        if (min < 60) return min + '분 ' + String(sec % 60).padStart(2, '0') + '초';
        const h = Math.floor(min / 60);
        return h + '시간 ' + String(min % 60).padStart(2, '0') + '분';
    }

    function stageIndex(stage, status, percent) {
        if (status === 'completed' || stage === 'STAGE_COMPLETED') return 5;
        if (status === 'failed' || stage === 'STAGE_FAILED') return Math.max(0, Math.min(4, stageIndex('', 'processing', percent)));
        const map = {
            STAGE_INIT: 0,
            STAGE_DOM_READY: 0,
            STAGE_SCROLLING: 1,
            STAGE_DOWNLOADING: 2,
            STAGE_PARSING: 3,
            STAGE_UPLOADING: 4,
        };
        if (map[stage] != null) return map[stage];
        const pct = Number(percent);
        if (!Number.isFinite(pct)) return status === 'pending' ? -1 : 0;
        if (pct >= 100) return 5;
        if (pct >= 90) return 4;
        if (pct >= 70) return 3;
        if (pct >= 45) return 2;
        if (pct >= 35) return 1;
        return status === 'pending' ? -1 : 0;
    }

    function progressFillPercent(item, pct, idx) {
        if (!item) return 0;
        const status = String(item.status || '');
        if (status === 'completed') return 100;
        if (status === 'failed') return clampPercent(pct);
        if (Number.isFinite(Number(pct)) && Number(pct) > 0) return clampPercent(pct);
        if (idx < 0) return 0;
        return clampPercent(((idx + 0.35) / PROGRESS_STEPS.length) * 100);
    }

    function clientProgressHtml(client, activeItem) {
        if (!client || !client.online || !activeItem) return '';
        const status = String(activeItem.status || '');
        const pct = activeItem && Number.isFinite(Number(activeItem.progressPercent)) ? clampPercent(activeItem.progressPercent) : 0;
        const idx = stageIndex(activeItem.stage, status, pct);
        const fill = progressFillPercent(activeItem, pct, idx);
        const label = stageLabel(activeItem.stage, status, pct) || (status === 'pending' ? '대기' : '실행 중');
        const stateCls = status === 'failed' ? ' is-error' : (status === 'completed' ? ' is-done' : '');
        const steps = PROGRESS_STEPS.map((s, i) => {
            const cls = i < idx ? 'done' : (i === idx ? 'active' : '');
            return `<span class="cc-step ${cls}" title="${esc(s.label)}"><span class="cc-step-dot"></span><span>${esc(s.label)}</span></span>`;
        }).join('');
        return `<div class="cc-progress${stateCls}">
            <div class="cc-progress-top">
                <span class="cc-progress-label">수집 진행</span>
                <strong>${esc(label)}</strong>
                <span class="cc-progress-pct">${pct}%</span>
            </div>
            <div class="cc-progress-bar" title="${esc(label)} ${pct}%"><span style="width:${fill}%"></span></div>
            <div class="cc-steps">${steps}</div>
        </div>`;
    }

    function clientDetailHtml(activeItem, fallbackUnit) {
        const src = activeItem || fallbackUnit;
        if (!src) return '';
        const startedAt = Number(activeItem && activeItem.startedAt || 0);
        const lastProgressAt = Number(activeItem && activeItem.lastProgressAt || 0);
        const elapsed = startedAt ? fmtShortDuration(Date.now() - startedAt) : '';
        const stalled = activeItem ? fmtShortDuration(itemStalledMs(activeItem)) : '';
        const retryCount = Number(activeItem && activeItem.retryCount || 0);
        const errorMsg = activeItem && activeItem.errorMsg ? clip(activeItem.errorMsg, 90) : '';
        const url = src.url || src.episodeUrl || '';
        const label = [
            src.episodeNum || src.num || '',
            src.episodeTitle || src.label || '',
        ].filter(Boolean).join(' ') || shortUrl(url);
        const parts = [
            elapsed ? `<span>경과 ${esc(elapsed)}</span>` : '',
            lastProgressAt ? `<span>갱신 ${fmtTime(lastProgressAt)}</span>` : '',
            stalled ? `<span>정체 ${esc(stalled)}</span>` : '',
            retryCount ? `<span>재시도 ${retryCount}</span>` : '',
        ].filter(Boolean).join('');
        return `<div class="cc-detail">
            <div class="cc-current">
                <span class="ico">▶️</span>
                ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span>${esc(label)}</span>`}
            </div>
            ${parts ? `<div class="cc-detail-meta">${parts}</div>` : ''}
            ${errorMsg ? `<div class="cc-error">${esc(errorMsg)}</div>` : ''}
        </div>`;
    }

    function riskBadgeHtml(client, activeItem) {
        if (!client || !client.online) return '';
        if (activeItem) {
            const status = String(activeItem.status || '');
            const retryCount = Number(activeItem.retryCount || 0);
            const stalledForMs = itemStalledMs(activeItem);
            const errorMsg = String(activeItem.errorMsg || '').trim();
            if (errorMsg) {
                return `<div class="cc-risk">${esc(clip(errorMsg, 70))}</div>`;
            }
            if (status === 'processing' && stalledForMs >= 90000) {
                const sec = Math.round(stalledForMs / 1000);
                const stage = stageLabel(activeItem.stage, status, activeItem.progressPercent);
                return `<div class="cc-risk">정체 ${sec}초${stage ? ` · ${esc(stage)}` : ''}</div>`;
            }
            if (status === 'processing' && _isOldVer(client.version) && !Number(activeItem.lastProgressAt || 0)) {
                return '<div class="cc-risk soft">구버전 · 정체시간 미보고</div>';
            }
            if (status === 'pending' && !client.running) {
                return '<div class="cc-risk">대기열 보유 · 스케줄러 대기</div>';
            }
            if (retryCount > 0) {
                return `<div class="cc-risk soft">재시도 ${retryCount}회</div>`;
            }
        }
        if (!client.running && Array.isArray(client.current) && client.current.length) {
            return '<div class="cc-risk">보유 lease · 작업 없음</div>';
        }
        return '';
    }

    function itemStalledMs(item) {
        if (!item) return 0;
        const base = Math.max(0, Number(item.stalledForMs || 0));
        const snapshotAt = Number(item._snapshotAt || 0);
        if (base > 0 && snapshotAt > 0) return base + Math.max(0, Date.now() - snapshotAt);
        const lastProgressAt = Number(item.lastProgressAt || 0);
        if (String(item.status || '') === 'processing' && lastProgressAt > 0) {
            return Math.max(0, Date.now() - lastProgressAt);
        }
        return base;
    }

    function shortUrl(u) {
        try { return new URL(u).pathname || u; } catch (_) { return u; }
    }

    function fmtDur(sec) {
        if (!isFinite(sec) || sec < 0) return '-';
        const m = Math.round(sec / 60);
        if (m < 1) return '1분 미만';
        if (m < 60) return m + '분';
        return Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
    }

    // ── ④ 테마 토글 (다크 ↔ 라이트) ──
    function applyTheme() {
        const light = (localStorage.getItem(LS.theme) || 'dark') === 'light';
        document.body.classList.toggle('light', light);
        const b = $('btn-theme');
        if (b) b.textContent = light ? '☀️' : '🌙';
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = light ? '#f4f6f9' : '#0f1115';
    }
    function toggleTheme() {
        const cur = (localStorage.getItem(LS.theme) || 'dark');
        localStorage.setItem(LS.theme, cur === 'light' ? 'dark' : 'light');
        applyTheme();
    }

    // ── ④ 화면 항상 켜두기 (Screen Wake Lock) ──
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator && !_wakeLock) {
                _wakeLock = await navigator.wakeLock.request('screen');
                _wakeLock.addEventListener('release', () => { _wakeLock = null; });
            }
        } catch (_) { /* 권한/미지원 → 무시 */ }
    }
    function releaseWakeLock() {
        try { if (_wakeLock) { _wakeLock.release(); _wakeLock = null; } } catch (_) {}
    }
    function applyWakeLock() {
        const on = localStorage.getItem(LS.wakelock) === '1';
        const cb = $('set-wakelock');
        if (cb) cb.checked = on;
        if (on) requestWakeLock(); else releaseWakeLock();
    }

    // ── ③ 알림 (브라우저 알림 + 비프) ──
    function beep() {
        try {
            _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (_audioCtx.state === 'suspended') _audioCtx.resume();
            const o = _audioCtx.createOscillator();
            const g = _audioCtx.createGain();
            o.connect(g); g.connect(_audioCtx.destination);
            o.type = 'sine'; o.frequency.value = 880;
            const t = _audioCtx.currentTime;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
            o.start(t); o.stop(t + 0.42);
        } catch (_) {}
    }
    function notify(title, body) {
        if (localStorage.getItem(LS.notify) !== '1') return;
        beep();
        try {
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification(title, { body: body || '', tag: 'tokisync', renotify: true });
            }
        } catch (_) {}
        toast(title + (body ? ' — ' + body : ''));
    }
    function onNotifyToggle() {
        const on = $('set-notify').checked;
        localStorage.setItem(LS.notify, on ? '1' : '0');
        if (on) {
            beep(); // 사용자 제스처 컨텍스트에서 오디오 활성화(모바일 정책)
            try {
                if ('Notification' in window && Notification.permission === 'default') {
                    Notification.requestPermission();
                }
            } catch (_) {}
        }
    }

    // ── ② 최근 투입 작품 칩 ──
    function getRecent() {
        try { return JSON.parse(localStorage.getItem(LS.recent) || '[]'); } catch (_) { return []; }
    }
    function addRecent(url, series) {
        if (!url) return;
        let r = getRecent().filter((x) => x.url !== url);
        r.unshift({ url, series: series || '', t: Date.now() });
        localStorage.setItem(LS.recent, JSON.stringify(r.slice(0, 8)));
        renderRecent();
    }
    function removeRecent(url) {
        localStorage.setItem(LS.recent, JSON.stringify(getRecent().filter((x) => x.url !== url)));
        renderRecent();
    }
    function renderRecent() {
        const box = $('recent-chips');
        const lbl = $('recent-label');
        if (!box) return;
        const r = getRecent();
        if (!r.length) { box.innerHTML = ''; if (lbl) lbl.style.display = 'none'; return; }
        if (lbl) lbl.style.display = '';
        box.innerHTML = r
            .map((x) => {
                const name = x.series || shortUrl(x.url);
                return `<span class="chip" data-url="${esc(x.url)}" title="${esc(x.url)}">
                    <span class="chip-label">${esc(name)}</span>
                    <span class="chip-x" data-x="1">✕</span>
                </span>`;
            })
            .join('');
        box.querySelectorAll('.chip').forEach((c) => {
            c.onclick = (e) => {
                if (e.target.dataset.x) { removeRecent(c.dataset.url); return; }
                $('exp-url').value = c.dataset.url;
                submitExpand();
            };
        });
    }

    // ── ① 진행 현황: ETA / 처리 속도 추정 + 전체 완료 알림 ──
    function updateEtaAndAlerts(pool) {
        const eta = $('pool-eta');
        const total = (pool && pool.total) || 0;
        const done = (pool && pool.done) || 0;
        const remaining = ((pool && pool.pending) || 0) + ((pool && pool.leased) || 0);
        const now = Date.now();

        // done이 줄었으면(풀 비움/재투입) 히스토리 리셋
        if (_doneHist.length && done < _doneHist[_doneHist.length - 1].done) _doneHist = [];
        _doneHist.push({ t: now, done });
        _doneHist = _doneHist.filter((h) => now - h.t <= 90000); // 90초 윈도우

        if (eta) {
            if (remaining > 0 && _doneHist.length >= 2) {
                const first = _doneHist[0];
                const dt = (now - first.t) / 1000;
                const dd = done - first.done;
                if (dt > 0 && dd > 0) {
                    const ratePerMin = (dd / dt) * 60;
                    const etaSec = remaining / (dd / dt);
                    eta.innerHTML = `<span>⏱️ 남은 시간 ~${esc(fmtDur(etaSec))}</span>` +
                        `<span class="done-rate">⚡ ${ratePerMin.toFixed(1)}회차/분</span>`;
                } else {
                    eta.innerHTML = `<span>⏱️ 속도 측정 중…</span>`;
                }
            } else {
                eta.innerHTML = '';
            }
        }

        // 전체 완료 엣지 알림: 직전엔 진행 중(remaining>0)이었는데 지금 0
        const active = total > 0 && remaining > 0;
        if (_prevActive && !active && done > 0) {
            notify('✅ 전체 다운로드 완료', `${done}건 완료 · 실패 ${(pool && pool.failed) || 0}`);
            _doneHist = [];
        }
        _prevActive = active;
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
        const n = (list && list.length) || 0;
        // 새 캡차 발생 엣지 알림(첫 로드 _prevCaptcha=-1 일 땐 건너뜀)
        if (_prevCaptcha >= 0 && n > _prevCaptcha) {
            const latest = list[n - 1] || {};
            notify('⚠️ 캡차 감지', latest.message || '원격 브라우저 확인 필요');
        }
        _prevCaptcha = n;
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

    // ── 멀티-IP lease 모드 렌더링 ──────────────────────────────────────
    const POOL_SEGS = [
        { k: 'done', cls: 'seg-done', label: '완료' },
        { k: 'leased', cls: 'seg-leased', label: '진행' },
        { k: 'pending', cls: 'seg-pending', label: '대기' },
        { k: 'failed', cls: 'seg-failed', label: '실패' },
    ];

    function renderPool(pool) {
        const bar = $('pool-bar');
        const counts = $('pool-counts');
        const total = (pool && pool.total) || 0;
        if (!total) {
            bar.innerHTML = '<div class="seg seg-empty" style="width:100%"></div>';
            counts.textContent = '작업 풀이 비어 있습니다. 아래에서 작업을 투입하세요.';
            return;
        }
        bar.innerHTML = POOL_SEGS.map((s) => {
            const n = pool[s.k] || 0;
            if (!n) return '';
            const pct = ((n / total) * 100).toFixed(1);
            return `<div class="seg ${s.cls}" style="width:${pct}%" title="${s.label} ${n}"></div>`;
        }).join('');
        counts.textContent = POOL_SEGS.map((s) => `${s.label} ${pool[s.k] || 0}`).join(' · ') + ` · 합계 ${total}`;
    }

    function renderClients(clients) {
        const box = $('clients');
        if (!clients || !clients.length) {
            box.innerHTML = '<div class="empty">연결된 클라이언트가 없습니다 (clientId 설정 필요).</div>';
            return;
        }
        box.innerHTML = clients
            .map((c) => {
                const p = c.progress && typeof c.progress === 'object' ? c.progress : null;
                const phase = p && (p.phase || (p.pos && p.total ? `${p.pos}/${p.total}` : '')) || '';
                const dot = c.online ? 'on' : 'off';
                const run = c.running ? '<span class="tag run">실행</span>' : '<span class="tag">정지</span>';
                // 현재 처리 중인 회차: progress.url과 매칭되는 leased unit 우선, 없으면 보유 lease 중 첫 항목
                const mine = _leasedMap[c.clientId] || [];
                let cur = null;
                if (p && p.url) cur = mine.find((u) => u.url === p.url) || null;
                if (!cur && mine.length) cur = mine[0];
                const currentItems = Array.isArray(c.currentItems) ? c.currentItems : [];
                const activeItem = currentItems.find((i) => i.status === 'processing') || currentItems[0] || null;
                const progressHtml = clientProgressHtml(c, activeItem);
                const detailHtml = c.online ? clientDetailHtml(activeItem, cur) : '';
                const riskHtml = riskBadgeHtml(c, activeItem);
                // 버전: 버전을 보내면 실제 버전을 표기(구버전이면 빨강, 최신이면 초록).
                //   버전 미전송(=260601-11 미만, 버전 동봉 코드 없음)은 실제 버전을 알 수 없어 "구버전?" 표기.
                const verShort = c.version ? (String(c.version).split('custom.').pop() || c.version) : '';
                const verHtml = verShort
                    ? `<span class="ver${_isOldVer(c.version) ? ' old' : ''}">v${esc(verShort)}</span>`
                    : `<span class="ver old">구버전?</span>`;
                const reportAge = c.online && c.ts
                    ? `보고 ${esc(fmtShortDuration(Math.max(0, Date.now() - Number(c.ts))) || '방금')} 전`
                    : '오프라인';
                return `<div class="client-card">
                    <div class="cc-head">
                        <span class="dot ${dot}"></span>
                        <strong>${esc(c.label || c.clientId)}</strong>
                        ${c.ip ? `<span class="muted">${esc(c.ip)}</span>` : ''}
                        <span class="tag done-count" title="이 클라이언트가 완료한 회차 수">✅ ${c.done || 0}건</span>
                        ${run}
                    </div>
                    ${detailHtml}
                    ${progressHtml}
                    ${riskHtml}
                    <div class="cc-meta muted">
                        보유 ${c.leased || 0}건${phase ? ` · ${esc(phase)}` : ''} · ${reportAge} ${verHtml}
                    </div>
                </div>`;
            })
            .join('');
    }

    function normalizeClientsSnapshot(data) {
        const snapshotAt = Date.now();
        return (data && Array.isArray(data.clients) ? data.clients : []).map((c) => ({
            ...c,
            currentItems: Array.isArray(c.currentItems)
                ? c.currentItems.map((i) => ({ ...i, _snapshotAt: snapshotAt }))
                : [],
        }));
    }

    function applyClientsSnapshot(data, options = {}) {
        if (!data || !data.ok) return { anyOnline: false, anyRunning: false };
        if (data.latestClientVersion) _latestVer = data.latestClientVersion;
        const clients = normalizeClientsSnapshot(data);
        _clientsCache = clients;
        _poolCache = data.pool || _poolCache;
        if (Array.isArray(data.leasedUnits)) {
            _leasedMap = {};
            data.leasedUnits.forEach((u) => {
                if (!u.clientId) return;
                (_leasedMap[u.clientId] = _leasedMap[u.clientId] || []).push(u);
            });
        }
        if (_poolCache) {
            renderPool(_poolCache);
            updateEtaAndAlerts(_poolCache);
        }
        renderClients(_clientsCache);
        updateLogClientOptions(_clientsCache);
        _paused = !!data.paused;
        const btn = $('btn-pause');
        if (btn) { btn.textContent = _paused ? '▶️ 재개' : '⏸️ 전체 정지'; btn.className = _paused ? 'primary' : 'blue'; }
        const badge = $('pause-badge');
        if (badge) badge.textContent = _paused ? '⏸️ 정지됨' : '';
        if (!options.skipSocket) {
            connectLogWs();
            subscribeLogWs();
        }
        const summary = {
            anyOnline: _clientsCache.some((c) => c.online),
            anyRunning: _clientsCache.some((c) => c.online && c.running),
        };
        if (options.updatePills) setPills(!!options.legacyOnline || summary.anyOnline, !!options.legacyRunning || summary.anyRunning);
        return summary;
    }

    function startLiveTick() {
        if (_liveTickTimer) return;
        _liveTickTimer = setInterval(() => {
            if (_clientsCache.length) renderClients(_clientsCache);
        }, 1000);
    }

    let _paused = false;
    // ── 실시간 로그 패널 ──
    function clearLogStream(msg) {
        const box = $('log-stream');
        if (box) box.innerHTML = `<div class="empty">${esc(msg || '로그 수신 대기 중…')}</div>`;
    }

    // 클라 드롭다운을 최신 클라 목록으로 동기화(선택 유지, 없으면 첫 온라인 클라 자동 선택)
    function updateLogClientOptions(clients) {
        const sel = $('log-client');
        if (!sel) return;
        const ids = clients.map((c) => c.clientId);
        if (_logSel && !ids.includes(_logSel)) _logSel = '';
        if (!_logSel) {
            const online = clients.find((c) => c.online);
            _logSel = (online || clients[0] || {}).clientId || '';
            _logSince = 0;
        }
        // 옵션 DOM은 목록/온라인 상태가 바뀔 때만 재구성(불필요한 깜빡임 방지)
        const want = clients.map((c) => `${c.clientId}:${c.online ? 1 : 0}`).join(',');
        if (sel._want !== want) {
            sel._want = want;
            sel.innerHTML = clients
                .map((c) => `<option value="${esc(c.clientId)}">${esc(c.label || c.clientId)} ${c.online ? '●' : '○'}</option>`)
                .join('') || '<option value="">(클라이언트 없음)</option>';
        }
        if (_logSel) sel.value = _logSel;
    }

    function appendLogs(logs) {
        const box = $('log-stream');
        if (!box) return;
        const empty = box.querySelector('.empty');
        if (empty) box.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const l of logs) {
            const div = document.createElement('div');
            div.className = 'log-line log-' + (l.type || 'normal');
            div.textContent = `${l.time || ''} ${l.msg || ''}`;
            frag.appendChild(div);
        }
        box.appendChild(frag);
        while (box.children.length > 300) box.removeChild(box.firstChild); // DOM 라인 상한
        const auto = $('log-autoscroll');
        if (!auto || auto.checked) box.scrollTop = box.scrollHeight;
    }

    function logWsUrl() {
        const u = new URL(getBase() || location.origin, location.href);
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        u.pathname = '/ws';
        u.search = '';
        u.hash = '';
        return u.toString();
    }

    function logWsOpen() {
        return _logWs && _logWs.readyState === WebSocket.OPEN;
    }

    function sendLogWs(msg) {
        if (!logWsOpen()) return false;
        try {
            _logWs.send(JSON.stringify(msg));
            return true;
        } catch (_) {
            return false;
        }
    }

    function closeLogWs() {
        if (_logWsReconnect) {
            clearTimeout(_logWsReconnect);
            _logWsReconnect = null;
        }
        _logWsNextAt = 0;
        if (_logWs) {
            const ws = _logWs;
            _logWs = null;
            try {
                ws.onclose = null;
                ws.close();
            } catch (_) {}
        }
        _logWsSubscribed = '';
    }

    function scheduleLogWsReconnect() {
        _logWsNextAt = Date.now() + 2000;
        if (_logWsReconnect) return;
        _logWsReconnect = setTimeout(() => {
            _logWsReconnect = null;
            connectLogWs();
        }, 2000);
    }

    function subscribeLogWs(force = false) {
        if (!_logSel) return;
        if (!force && _logWsSubscribed === _logSel && logWsOpen()) return;
        if (sendLogWs({ type: 'subscribeLogs', clientId: _logSel, since: _logSince })) {
            _logWsSubscribed = _logSel;
            return;
        }
        connectLogWs();
    }

    function handleLogWsMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && msg.type === 'clients') {
            applyClientsSnapshot(msg, { skipSocket: true, updatePills: true });
            return;
        }
        if (!msg || msg.type !== 'logs' || msg.clientId !== _logSel) return;
        const logs = Array.isArray(msg.logs) ? msg.logs : [];
        if (logs.length) appendLogs(logs);
        const lastSeq = Number(msg.lastSeq);
        if (Number.isFinite(lastSeq)) {
            _logSince = lastSeq;
        } else if (logs.length) {
            _logSince = Number(logs[logs.length - 1].seq) || _logSince;
        }
    }

    function connectLogWs() {
        if (typeof WebSocket === 'undefined') return false;
        if (Date.now() < _logWsNextAt) return false;
        const url = logWsUrl();
        const token = getToken();
        const key = `${url}|${token}`;
        if (_logWs && (_logWs.readyState === WebSocket.OPEN || _logWs.readyState === WebSocket.CONNECTING) && _logWs._key === key) {
            return true;
        }
        closeLogWs();
        try {
            const ws = new WebSocket(url);
            ws._key = key;
            _logWs = ws;
            ws.onopen = () => {
                _logWsNextAt = 0;
                sendLogWs({ type: 'hello', role: 'dashboard', token });
                subscribeLogWs(true);
            };
            ws.onmessage = handleLogWsMessage;
            ws.onclose = () => {
                if (_logWs === ws) _logWs = null;
                _logWsSubscribed = '';
                scheduleLogWsReconnect();
            };
            ws.onerror = () => {
                try { ws.close(); } catch (_) {}
            };
            return true;
        } catch (_) {
            scheduleLogWsReconnect();
            return false;
        }
    }

    // 선택된 클라의 로그 증분 폴(refreshClients 주기에 묻어서 호출)
    async function pollLogs() {
        if (!_logSel) return;
        if (logWsOpen()) return;
        try {
            const r = await api(`/logs?clientId=${encodeURIComponent(_logSel)}&since=${_logSince}`);
            const logs = r.logs || [];
            if (logs.length) {
                appendLogs(logs);
                _logSince = r.lastSeq || _logSince;
            }
        } catch (_) { /* 구버전 서버/일시 오류 → 다음 주기 */ }
    }

    async function refreshClients() {
        try {
            const data = await api('/clients');
            if (!Array.isArray(data.leasedUnits)) {
                // 구버전 서버 호환: 새 서버는 /clients에 leasedUnits를 같이 내려준다.
                try {
                    const lu = await api('/units?status=leased');
                    data.leasedUnits = lu.units || [];
                } catch (_) { data.leasedUnits = []; }
            }
            const summary = applyClientsSnapshot(data);
            await pollLogs();
            return summary;
        } catch (e) {
            // 구버전 서버(엔드포인트 없음)면 패널 숨김
            $('pool-panel').style.display = 'none';
            return null;
        }
    }

    // 전체 정지 ↔ 재개 토글
    async function togglePause() {
        try {
            await api(_paused ? '/resume' : '/pause', { method: 'POST' });
            toast(_paused ? '재개됨' : '전체 정지됨 (새 작업 중단)');
            refresh();
        } catch (e) {
            toast('실패: ' + e.message);
        }
    }

    // 작업 풀 전체 비우기
    async function clearPool() {
        if (!confirm('작업 풀을 전부 비울까요? (진행 중 회차 포함 모두 제거)')) return;
        try {
            await api('/jobs/clear', { method: 'POST' });
            toast('작업 풀 비움');
            refresh();
        } catch (e) {
            toast('실패: ' + e.message);
        }
    }

    async function refresh() {
        let legacyOnline = false, legacyRunning = false;
        try {
            const data = await api('/queue');
            const report = data.report || {};
            legacyOnline = !!data.online;
            legacyRunning = !!report.running;
            renderQueue(report);
            renderCaptcha(data.captcha);
            renderProgress(report, data.online);
            $('footer').textContent = `서버 시각 ${fmtTime(data.serverTime)} · seq ${data.seq}`;
            $('conn-info').textContent = `연결됨: ${getBase() || location.origin} · 업데이트 URL: ${scriptUpdateUrl()}`;
        } catch (e) {
            $('footer').textContent = `연결 실패: ${e.message}`;
        }
        // 레거시(단일 모드) + lease(멀티-IP) 둘 중 하나라도 온라인이면 "온라인"으로 표시
        const lease = await refreshClients();
        setPills(legacyOnline || !!(lease && lease.anyOnline), legacyRunning || !!(lease && lease.anyRunning));
    }

    // 작업 투입 (/jobs)
    async function submitJobs() {
        const series = $('job-series').value.trim();
        const text = $('job-urls').value;
        const urls = text.split(/[\s\n]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
        if (!urls.length) return toast('회차 URL을 입력하세요');
        try {
            const r = await api('/jobs', { method: 'POST', body: { series, urls } });
            $('job-urls').value = '';
            toast(`${r.added}개 투입 (중복 ${r.skipped} 제외)`);
            refresh();
        } catch (e) {
            toast('투입 실패: ' + e.message);
        }
    }

    // 작품 메인 URL 자동 펼침 (/jobs/expand)
    async function submitExpand() {
        const seriesUrl = $('exp-url').value.trim();
        if (!/^https?:\/\//i.test(seriesUrl)) return toast('작품 메인 URL을 입력하세요');
        const series = $('job-series').value.trim();
        try {
            await api('/jobs/expand', { method: 'POST', body: { seriesUrl, series } });
            addRecent(seriesUrl, series); // ② 최근 투입 칩에 기록
            $('exp-url').value = '';
            toast('펼침 요청 전송 — 온라인 클라이언트가 회차를 투입합니다');
            setTimeout(refresh, 1500);
        } catch (e) {
            toast('펼침 요청 실패: ' + e.message);
        }
    }

    // 범위 템플릿 → URL 목록 생성({n} 치환)
    function genFromTemplate() {
        const tpl = $('job-tpl').value.trim();
        const from = parseInt($('job-from').value, 10);
        const to = parseInt($('job-to').value, 10);
        if (!tpl.includes('{n}')) return toast('템플릿에 {n}을 포함하세요');
        if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return toast('범위가 올바르지 않습니다');
        if (to - from > 2000) return toast('한 번에 2000개까지 생성 가능');
        const urls = [];
        for (let n = from; n <= to; n++) urls.push(tpl.replace(/\{n\}/g, String(n)));
        const cur = $('job-urls').value.trim();
        $('job-urls').value = (cur ? cur + '\n' : '') + urls.join('\n');
        toast(`${urls.length}개 생성됨`);
    }

    function nasPayload() {
        const body = {
            webdavUrl: $('nas-url').value.trim(),
            user: $('nas-user').value.trim(),
            pass: $('nas-pass').value,
            category: $('nas-category').value.trim() || 'Webtoon',
            series: $('nas-series').value.trim(),
            minSizeRatio: Math.max(0.1, Math.min(1, (parseInt($('nas-ratio').value, 10) || 50) / 100)),
        };
        localStorage.setItem(LS.nasUrl, body.webdavUrl);
        localStorage.setItem(LS.nasUser, body.user);
        localStorage.setItem(LS.nasPass, body.pass);
        localStorage.setItem(LS.nasCategory, body.category);
        localStorage.setItem(LS.nasRatio, String(Math.round(body.minSizeRatio * 100)));
        localStorage.setItem(LS.nasSeries, body.series);
        localStorage.setItem(LS.nasUpdateUrl, $('nas-update-url').value.trim());
        return body;
    }

    function nasStatusLabel(status) {
        if (status === 'valid') return '저장됨';
        if (status === 'small') return '손상 의심';
        return '누락';
    }

    function fmtBytes(n) {
        const v = Number(n) || 0;
        if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(1)}GB`;
        if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
        if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`;
        return `${v}B`;
    }

    function selectedCategory() {
        return ($('nas-category').value || '').trim() || 'Webtoon';
    }

    function extractSeriesIdFromFolder(folderName) {
        const text = String(folderName || '').trim();
        const bracket = text.match(/^\[([^\]]+)\]/);
        if (bracket && bracket[1]) return bracket[1].trim();
        const leading = text.match(/^([0-9A-Za-z_-]+)/);
        return leading ? leading[1] : '';
    }

    function pathForCategory(category) {
        const cat = String(category || '').trim().toLowerCase();
        if (cat.includes('novel') || cat.includes('book')) return 'novel';
        if (cat.includes('manga') || cat.includes('manhwa')) return 'manhwa';
        return 'webtoon';
    }

    function updateUrlOrigin() {
        const current = $('nas-update-url').value.trim();
        if (/^https?:\/\//i.test(current)) {
            try { return new URL(current).origin; } catch (_) {}
        }
        return 'https://sbxh4.com';
    }

    function buildNasMainUrl() {
        const series = $('nas-series').value.trim();
        const seriesId = extractSeriesIdFromFolder(series);
        if (!seriesId) return toast('NAS 작품 폴더명에서 ID를 찾지 못했습니다');
        const categoryPath = pathForCategory(selectedCategory());
        const url = `${updateUrlOrigin()}/${categoryPath}/${encodeURIComponent(seriesId)}`;
        $('nas-update-url').value = url;
        localStorage.setItem(LS.nasUpdateUrl, url);
        toast(`메인 URL 생성: /${categoryPath}/${seriesId}`);
    }

    function renderNasCriteria(data) {
        const ratio = parseInt(localStorage.getItem(LS.nasRatio) || $('nas-ratio').value || '50', 10) || 50;
        return `<div class="nas-criteria">
            <div><strong>저장 기준</strong> ${esc(data.category || selectedCategory())}/${esc(data.series || $('nas-series').value.trim() || '-')}</div>
            <div>유효 파일은 같은 회차 번호의 NAS 파일 중, 최대 파일 크기의 ${ratio}% 이상인 파일입니다.</div>
            <div>재다운로드 대상은 서버 상태가 완료/실패이고 NAS 파일이 누락되었거나 손상 의심인 항목입니다.</div>
        </div>`;
    }

    function renderNasUpdateNotice({ id, seriesUrl, series, category }) {
        const box = $('nas-result');
        const current = box.innerHTML && !box.querySelector('.empty') ? box.innerHTML : '';
        box.innerHTML = `<div class="nas-update-card">
            <strong>업데이트 확인 요청 전송</strong>
            <div>작품 메인 URL: <span>${esc(seriesUrl)}</span></div>
            <div>NAS 기준: <span>${esc(category || selectedCategory())}/${esc(series || '-')}</span></div>
            <div>요청 ID: <span>${esc(id || '-')}</span> · 온라인 클라이언트가 회차 목록을 펼쳐 새 unit을 추가합니다.</div>
        </div>${current}`;
    }

    function renderNasAudit(data) {
        const box = $('nas-result');
        if (!data || !data.summary) {
            box.innerHTML = '<div class="empty">NAS 스캔 결과가 없습니다.</div>';
            return;
        }
        const s = data.summary;
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const important = rows
            .filter((r) => r.retryable || r.nasStatus !== 'valid' || r.status === 'failed')
            .slice(0, 80);
        const rowHtml = important.length
            ? important.map((r) => {
                const cls = r.nasStatus === 'valid' ? 'ok' : (r.nasStatus === 'small' ? 'warn' : 'bad');
                const file = r.fileName ? `${r.fileName} · ${fmtBytes(r.fileSize)}` : 'NAS 파일 없음';
                return `<div class="nas-row ${cls}">
                    <div class="nas-row-main">
                        <strong>${esc(r.num || '-')} ${esc(r.label || '')}</strong>
                        <span class="nas-badge">${esc(nasStatusLabel(r.nasStatus))}</span>
                        ${r.retryable ? '<span class="nas-badge retry">재다운로드 대상</span>' : ''}
                    </div>
                    <div class="nas-row-meta">${esc(r.status)} · attempts ${Number(r.attempts || 0)} · ${esc(file)}</div>
                </div>`;
            }).join('')
            : '<div class="empty">누락/손상/실패 항목이 없습니다.</div>';
        box.innerHTML = `${renderNasCriteria(data)}
        <div class="nas-summary">
            <span>NAS 유효 ${s.validFiles}/${s.files}</span>
            <span>서버 unit ${s.units}</span>
            <span>저장 매칭 ${s.stored}</span>
            <span>누락 ${s.missing}</span>
            <span>손상 의심 ${s.small}</span>
            <span>재다운로드 ${s.retryable}</span>
        </div>
        <div class="muted">폴더: ${esc(data.folderUrl || '')} · 파일 크기 기준 ${fmtBytes(data.thresholdBytes || 0)} 이상</div>
        <div class="nas-rows">${rowHtml}</div>`;
    }

    async function loadNasCategoryList() {
        const body = nasPayload();
        if (!body.webdavUrl) return toast('WebDAV URL을 입력하세요');
        try {
            const r = await api('/nas/categories', { method: 'POST', body });
            const sel = $('nas-category-list');
            const defaults = ['Webtoon', 'Manga', 'Novel'];
            const list = Array.from(new Set([...(r.categories || []), ...defaults]));
            sel.innerHTML = list.length
                ? '<option value="">카테고리 선택</option>' + list.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')
                : '<option value="">카테고리 없음</option>';
            if (body.category) sel.value = body.category;
            toast(`${(r.categories || []).length}개 카테고리 폴더`);
        } catch (e) {
            toast('NAS 카테고리 조회 실패: ' + e.message);
        }
    }

    async function loadNasSeriesList() {
        const body = nasPayload();
        if (!body.webdavUrl) return toast('WebDAV URL을 입력하세요');
        if (!body.category) return toast('카테고리 폴더를 선택하세요');
        try {
            const r = await api('/nas/series', { method: 'POST', body });
            const sel = $('nas-series-list');
            const list = r.series || [];
            sel.innerHTML = list.length
                ? '<option value="">NAS 폴더 선택</option>' + list.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')
                : '<option value="">폴더 없음</option>';
            sel.onchange = () => {
                if (sel.value) {
                    $('nas-series').value = sel.value;
                    localStorage.setItem(LS.nasSeries, sel.value);
                }
            };
            toast(`${list.length}개 작품 폴더`);
        } catch (e) {
            toast('NAS 폴더 조회 실패: ' + e.message);
        }
    }

    async function scanNas() {
        const body = nasPayload();
        if (!body.webdavUrl) return toast('WebDAV URL을 입력하세요');
        if (!body.series) return toast('NAS 작품 폴더를 입력하세요');
        $('nas-result').innerHTML = '<div class="empty">NAS 스캔 중…</div>';
        try {
            _nasAudit = await api('/nas/scan', { method: 'POST', body });
            renderNasAudit(_nasAudit);
            toast(`NAS 스캔 완료 · 재다운로드 ${(_nasAudit.suggestedIds || []).length}건`);
        } catch (e) {
            _nasAudit = null;
            $('nas-result').innerHTML = `<div class="empty">스캔 실패: ${esc(e.message)}</div>`;
            toast('NAS 스캔 실패: ' + e.message);
        }
    }

    async function requeueNasSuggested() {
        const ids = (_nasAudit && Array.isArray(_nasAudit.suggestedIds)) ? _nasAudit.suggestedIds : [];
        if (!ids.length) return toast('재다운로드 대상이 없습니다');
        if (!confirm(`${ids.length}건을 NAS 기준으로 재다운로드할까요?`)) return;
        try {
            const r = await api('/nas/requeue', { method: 'POST', body: { ids } });
            toast(`${r.requeued}건 재투입`);
            await scanNas();
            refresh();
        } catch (e) {
            toast('NAS 재투입 실패: ' + e.message);
        }
    }

    async function updateNasSeries() {
        const seriesUrl = $('nas-update-url').value.trim();
        const series = $('nas-series').value.trim();
        const category = selectedCategory();
        localStorage.setItem(LS.nasUpdateUrl, seriesUrl);
        if (!/^https?:\/\//i.test(seriesUrl)) return toast('업데이트용 작품 메인 URL을 입력하세요');
        try {
            const r = await api('/jobs/expand', { method: 'POST', body: { seriesUrl, series } });
            addRecent(seriesUrl, series);
            renderNasUpdateNotice({ id: r.id, seriesUrl, series, category });
            toast('업데이트 확인 요청 전송');
            setTimeout(refresh, 1500);
        } catch (e) {
            toast('업데이트 요청 실패: ' + e.message);
        }
    }

    // 실패/멈춤 unit 재투입
    async function requeueByStatus(status, label) {
        try {
            const u = await api('/units?status=' + encodeURIComponent(status));
            const ids = (u.units || []).map((x) => x.id);
            if (!ids.length) return toast(`${label} unit이 없습니다`);
            const r = await api('/requeue', { method: 'POST', body: { ids } });
            toast(`${r.requeued}건 재투입`);
            refresh();
        } catch (e) {
            toast('재투입 실패: ' + e.message);
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
        $('set-notify').checked = localStorage.getItem(LS.notify) === '1';
        $('set-wakelock').checked = localStorage.getItem(LS.wakelock) === '1';
        if ($('nas-url')) {
            $('nas-url').value = localStorage.getItem(LS.nasUrl) || '';
            $('nas-user').value = localStorage.getItem(LS.nasUser) || '';
            $('nas-pass').value = localStorage.getItem(LS.nasPass) || '';
            $('nas-category').value = localStorage.getItem(LS.nasCategory) || 'Webtoon';
            $('nas-category-list').value = $('nas-category').value;
            $('nas-ratio').value = localStorage.getItem(LS.nasRatio) || '50';
            $('nas-series').value = localStorage.getItem(LS.nasSeries) || '';
            $('nas-update-url').value = localStorage.getItem(LS.nasUpdateUrl) || '';
        }
    }

    function saveSettings() {
        localStorage.setItem(LS.base, $('set-base').value.trim());
        localStorage.setItem(LS.token, $('set-token').value.trim());
        localStorage.setItem(LS.poll, String(Math.max(2, parseInt($('set-poll').value, 10) || 3)));
        toast('저장됨');
        closeLogWs();
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
        $('btn-jobs').onclick = submitJobs;
        $('btn-expand').onclick = submitExpand;
        $('btn-tpl-gen').onclick = genFromTemplate;
        $('btn-requeue-failed').onclick = () => requeueByStatus('failed', '실패');
        $('btn-requeue-stuck').onclick = () => requeueByStatus('leased', '진행 중');
        $('btn-pause').onclick = togglePause;
        $('btn-clear-pool').onclick = clearPool;
        $('btn-nas-categories').onclick = loadNasCategoryList;
        $('btn-nas-series').onclick = loadNasSeriesList;
        $('btn-nas-scan').onclick = scanNas;
        $('btn-nas-requeue').onclick = requeueNasSuggested;
        $('btn-nas-update').onclick = updateNasSeries;
        $('btn-nas-build-url').onclick = buildNasMainUrl;
        $('nas-category-list').onchange = () => {
            if ($('nas-category-list').value) {
                $('nas-category').value = $('nas-category-list').value;
                localStorage.setItem(LS.nasCategory, $('nas-category').value);
                $('nas-series').value = '';
                localStorage.setItem(LS.nasSeries, '');
                $('nas-series-list').innerHTML = '<option value="">작품 폴더 목록을 다시 불러오세요</option>';
            }
        };
        $('nas-category').onchange = () => {
            localStorage.setItem(LS.nasCategory, selectedCategory());
            $('nas-category-list').value = selectedCategory();
            $('nas-series').value = '';
            localStorage.setItem(LS.nasSeries, '');
            $('nas-series-list').innerHTML = '<option value="">작품 폴더 목록을 다시 불러오세요</option>';
        };
        // 편의 기능 배선
        $('btn-theme').onclick = toggleTheme;
        $('set-notify').onchange = onNotifyToggle;
        $('set-wakelock').onchange = () => {
            localStorage.setItem(LS.wakelock, $('set-wakelock').checked ? '1' : '0');
            applyWakeLock();
        };
        // 백그라운드 전환 시 브라우저가 wake lock을 자동 해제 → 복귀 시 재획득
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && localStorage.getItem(LS.wakelock) === '1') requestWakeLock();
        });
        // 실시간 로그: 클라 선택 변경 시 스트림 초기화 + 증분 커서 리셋
        _logSel = localStorage.getItem(LS.logsel) || '';
        const logSelEl = $('log-client');
        if (logSelEl) logSelEl.onchange = () => {
            _logSel = logSelEl.value;
            _logSince = 0;
            localStorage.setItem(LS.logsel, _logSel);
            clearLogStream(_logSel ? `${_logSel} 로그 수신 대기 중…` : '클라이언트를 선택하세요');
            _logWsSubscribed = '';
            subscribeLogWs(true);
            pollLogs();
        };
        applyTheme();
        applyWakeLock();
        renderRecent();
        refresh();
        startPolling();
        startLiveTick();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
