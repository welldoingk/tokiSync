import { main } from './main.js';
import { getConfig } from './config.js';
import { scrollToLoad, fetchBlobWithXHR, blobToArrayBuffer, waitForContent, sleep } from './utils.js';

(async function () {
    'use strict';

    // [DIAG] 이등분 진단 게이트 — localStorage['__toki_diag'] (기본 99=풀동작).
    //   0: 아무것도 안 함 | 1: document-start 패치만 | 2: +main(파서) | 3: +히스토리/원격 | 4: +UI(FAB)
    const __TD = (function () { try { var v = localStorage.getItem('__toki_diag'); return v == null ? 99 : (parseInt(v, 10) || 0); } catch (e) { return 99; } })();
    if (__TD < 1) return; // 레벨 0: 즉시 종료 (아무 패치/실행 없음)

    // =============================================================
    // 📝 [통합 로깅 시스템] localStorage 기반 부모-자식 통합 로그 캡처
    // =============================================================
    const originalConsole = {
        log: console.log,
        debug: console.debug,
        warn: console.warn,
        error: console.error
    };
    
    const ctxMarker = (window.name === 'mv-worker' || (window.opener && window.name === '')) ? '[Worker]' : '[Parent]';

    function saveLogToStorage(level, args) {
        try {
            const msg = args.map(a => {
                if (a && typeof a === 'object') {
                    try { return JSON.stringify(a); } catch(e) { return String(a); }
                }
                return String(a);
            }).join(' ');
            
            const now = new Date();
            const timeStr = now.toISOString().split('T')[1].replace('Z', '') + '.' + String(now.getMilliseconds()).padStart(3, '0');
            const line = `[${timeStr}] ${ctxMarker} [${level}] ${msg}\n`;
            
            // [anti-fingerprint] 페이지(사이트) localStorage 대신 GM 저장소 사용 → 사이트에서 TOKI_* 키가 보이지 않음
            let existing = (typeof GM_getValue !== 'undefined') ? (GM_getValue('TOKI_DEBUG_LOGS', '') || '') : '';
            if (existing.length > 300000) existing = existing.slice(-150000);
            if (typeof GM_setValue !== 'undefined') GM_setValue('TOKI_DEBUG_LOGS', existing + line);
        } catch (err) {}
    }

    console.log = function(...args) { saveLogToStorage('LOG', args); originalConsole.log.apply(this, args); };
    console.debug = function(...args) { saveLogToStorage('DEBUG', args); originalConsole.debug.apply(this, args); };
    console.warn = function(...args) { saveLogToStorage('WARN', args); originalConsole.warn.apply(this, args); };
    console.error = function(...args) { saveLogToStorage('ERROR', args); originalConsole.error.apply(this, args); };

    window.downloadTokiLogs = function() {
        try {
            const logs = ((typeof GM_getValue !== 'undefined') ? GM_getValue('TOKI_DEBUG_LOGS', '') : '') || '로그가 없습니다.';
            const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tokisync_debug_${new Date().getTime()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            originalConsole.log("💾 텍스트 로그 파일 다운로드 완료.");
        } catch (e) {
            originalConsole.error("로그 다운로드 실패:", e);
        }
    };
    
    window.clearTokiLogs = function() {
        if (typeof GM_deleteValue !== 'undefined') GM_deleteValue('TOKI_DEBUG_LOGS');
        originalConsole.log("🗑️ 텍스트 로그 초기화 완료.");
    };



    // =============================================================
    // 🛡️ [보안 극복] attachShadow Proxy 는 워커(추출) 블록으로 이동됨 (아래 isWorkerPopup).
    //   전역(document-start) 설치 시 닫힌 shadow 를 강제 open → 사이트 안티-변조 탐지
    //   (userscript_spoof / prototype_tampered)에 걸려 광고 ack 차단 → 만화 로드 실패.
    //   읽기 탭에선 불필요하므로 다운로드 워커에서만 설치한다.
    // =============================================================
    // 🚀 [자식 팝업 - Worker] 다형성 미디어 수집 및 부모 창 IPC 브릿지
    // =============================================================
    let isSessionWorker = false;
    try { isSessionWorker = sessionStorage.getItem('mv_wf') === '1'; } catch(e) {}

    const isWorkerPopup = (
        window.name === 'mv-worker' || 
        (window.opener && window.name === '') ||
        isSessionWorker
    );



    if (isWorkerPopup) {
        // 향후 location.replace 등으로 인한 컨텍스트 소실(짝수 회차 방어)을 대비해 현재 탭(세션)에 워커 각인
        try { sessionStorage.setItem('mv_wf', '1'); } catch(e) {}
        console.log("🚀 [TokiSync-Worker] 자식 팝업 수동 대기 모드 기동");

        // [추출용] 닫힌 Shadow DOM 강제 개방 — 콘텐츠 종류별 자동 분기.
        //   attachShadow Proxy 는 닫힌 shadow 를 강제 open 시키는데, 만화 페이지에선 사이트의
        //   안티-변조 탐지(userscript_spoof)에 걸려 워커가 ntk_blk 하드차단됨(이미지 0). 반면
        //   sbxh 소설 본문은 닫힌 shadow 에 봉인돼 있어 force-open 없이는 추출 불가(실측: 소설
        //   페이지에선 force-open 해도 ntk_blk 미발생).
        //   → 워커 URL 이 소설(`/novel/`)일 때만 자동 ON, 만화(`/manhwa·/manga·/webtoon`)는 OFF.
        //     수동 오버라이드: GM_setValue('TOKI_FORCE_OPEN_SHADOW', true) → 모든 사이트에서 강제 ON.
        try {
            const _urlIsNovel = /\/novel\//i.test(location.pathname);
            const _gmForce = typeof GM_getValue !== 'undefined' &&
                (GM_getValue('TOKI_FORCE_OPEN_SHADOW', false) === true ||
                 GM_getValue('TOKI_FORCE_OPEN_SHADOW', false) === '1');
            if (_urlIsNovel || _gmForce) {
                const originalAttachShadow = Element.prototype.attachShadow;
                Element.prototype.attachShadow = new Proxy(originalAttachShadow, {
                    apply(target, thisArg, argumentsList) {
                        if (argumentsList[0] && argumentsList[0].mode === 'closed') {
                            console.log('[TokiSync-Worker] 🔒 닫힌 Shadow DOM 감지 -> Open 모드로 개방 완료');
                            argumentsList[0].mode = 'open';
                        }
                        return Reflect.apply(target, thisArg, argumentsList);
                    }
                });
            }
        } catch (e) {}

        // window.opener 은폐 및 로컬 참조 복사
        const parentWin = window.opener;
        try {
            Object.defineProperty(window, 'opener', { value: null });
        } catch (e) {
            window.opener = null;
        }

        // 부모 창에게 준비 완료 신호 전송 (부모가 지시를 줄 때까지 1초마다 Heartbeat)
        let readyInterval = null;
        const startReadyHeartbeat = () => {
            if (readyInterval) clearInterval(readyInterval);
            
            const sendReady = () => {
                if (parentWin) {
                    console.log("[TokiSync-Worker] 📢 부모 창에 준비 완료 신호 전송 (Handshake Heartbeat)");
                    parentWin.postMessage({
                        type: 'TOKI_WORKER_READY',
                        timestamp: Date.now()
                    }, '*');
                }
            };

            sendReady();
            readyInterval = setInterval(sendReady, 1000);
        };

        // 중복 실행 방지용 락(Lock)
        let isExtracting = false;

        // 지시 수신 리스너 셋업
        window.addEventListener('message', async (event) => {
            if (event.data && event.data.type === 'TOKI_START_EXTRACTION') {
                // --- Cloudflare/Captcha Check ---
                const isCloudflare = document.title.includes('Just a moment') ||
                                     document.getElementById('cf-challenge-running') ||
                                     document.querySelector('.cf-browser-verification') ||
                                     document.getElementById('challenge-running');
                
                if (isCloudflare) {
                    console.warn("⚠️ [TokiSync-Worker] 클라우드플레어 인증/대기 페이지 감지. 통과를 대기합니다.");
                    if (parentWin) {
                        parentWin.postMessage({ type: 'TOKI_CAPTCHA_DETECTED', timestamp: Date.now() }, '*');
                    }
                    return; // 캡차가 통과되어 새 페이지로 리다이렉트 될 때까지 중복 실행을 막으며 조용히 대기
                }

                if (isExtracting) {
                    return;
                }
                isExtracting = true;

                const { targetType, viewerCfg } = event.data;
                console.log(`🚀 [TokiSync-Worker] 부모의 동작 지시문 수신 완료! (유형: ${targetType})`);

                // 하트비트 즉각 해제
                if (readyInterval) {
                    clearInterval(readyInterval);
                    readyInterval = null;
                }

                if (targetType === 'novel') {
                    // [소설 수집 동작]
                    let attempt = 0;
                    const checkInterval = setInterval(() => {
                        attempt++;
                        console.log(`[TokiSync-Worker] 소설 Shadow DOM 대기 중... (시도: ${attempt}회)`);

                        const novelSel = viewerCfg.novelContent || '#novel_content';
                        // 동적 셀렉터 및 폴백 적용 — 본문 shadow 호스트 탐지
                        //  sbxh(뉴토끼): 본문은 `article.novel-viewer > div[style*="--novel-font-size"]`의
                        //  닫힌 shadow 에 봉인됨(TOKI_FORCE_OPEN_SHADOW 로 강제 open 시 .shadowRoot 접근 가능).
                        const novelRoot = document.querySelector(novelSel);
                        const shadowHost =
                               (novelRoot && novelRoot.shadowRoot ? novelRoot : null)
                            || (novelRoot && novelRoot.querySelector('div[style*="--novel-font-size"]'))
                            || document.querySelector('div[style*="--novel-font-size"]')
                            || document.querySelector('.novel-epub-rendered')?.getRootNode()?.host
                            || document.querySelector(novelSel)?.getRootNode()?.host
                            || document.querySelector('.vw-bot-mini--novel')?.parentElement?.querySelector('div[style*="--novel-font-size"]');

                        if (shadowHost && shadowHost.shadowRoot) {
                            clearInterval(checkInterval);
                            let content = '';

                            // 1차: <p> 태그 수집 (innerText 로 <br> 줄바꿈 보존)
                            const pTags = shadowHost.shadowRoot.querySelectorAll('.novel-epub-rendered p, p');
                            if (pTags.length > 0) {
                                content = Array.from(pTags)
                                    .map(p => (p.innerText || p.textContent || '').trim())
                                    .filter(text => text.length > 0)
                                    .join('\n\n');
                            } else {
                                // 2차 폴백: innerText
                                const bodyEl = shadowHost.shadowRoot.querySelector('.novel-epub-rendered');
                                if (bodyEl) {
                                    content = bodyEl.innerText || bodyEl.textContent;
                                } else {
                                    // 3차 폴백: 노이즈 제거
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = shadowHost.shadowRoot.innerHTML;
                                    tempDiv.querySelectorAll('style, script').forEach(el => el.remove());
                                    content = tempDiv.innerText || tempDiv.textContent;
                                }
                            }

                            if (content && content.trim().length > 100) {
                                console.log(`🎯 [TokiSync-Worker] 소설 텍스트 정밀 조립 완료 - 길이: ${content.length}자`);
                                if (parentWin) {
                                    parentWin.postMessage({
                                        type: 'TOKI_MEDIA_DATA',
                                        data: {
                                            novelId: location.pathname.split('/')[2] || '0',
                                            episodeId: location.pathname.split('/')[3] || '0',
                                            contentType: 'novel',
                                            content: content.trim(),
                                            images: null,
                                            nextUrl: document.querySelector('a#next_episode')?.href || null,
                                            timestamp: Date.now()
                                        }
                                    }, '*');
                                }
                            }
                        }
                    }, 500);
                } else if (targetType === 'comic') {
                    // [만화 수집 동작]
                    try {
                        console.log("[TokiSync-Worker] ⏳ 웹툰/만화 콘텐츠 DOM 렌더링 대기 시작...");
                        
                        // 1) 팝업 창 내부에 실제 만화 이미지 요소가 렌더링될 때까지 최대 10초 대기
                        const contentDoc = await waitForContent(window, 10000, viewerCfg);
                        
                        if (!contentDoc) {
                            console.warn("[TokiSync-Worker] ⚠️ 10초 대기 내에 콘텐츠 렌더링 미감지. 갈무리 우선 진행.");
                        } else {
                            console.log("[TokiSync-Worker] 🎯 웹툰 콘텐츠 감지 완료! 1.5초 안정화 대기 시작...");
                        }

                        // 2) DOM 안정화 딜레이 (1.5초 → 0.8초, 스크롤 꼬임 방지 최소선)
                        await sleep(800);

                        console.log("[TokiSync-Worker] 🚀 안정화 완료. 1차 스크롤 및 다운로드 돌입.");

                        // 3) 지연 로딩 이미지 스크롤 활성화 (부모가 제공한 viewerCfg 적용)
                        await scrollToLoad(document, 25000, viewerCfg);

                        // 이미지 다운로드를 처리하는 비동기 헬퍼 정의 (동시성: 설정값, 기본 8)
                        const runImageDownloads = async (imageUrls) => {
                            const downloaded = [];
                            let CONCURRENCY_LIMIT = 8;
                            try { CONCURRENCY_LIMIT = getConfig().imgConcurrency || 8; } catch (e) {}

                            for (let i = 0; i < imageUrls.length; i += CONCURRENCY_LIMIT) {
                                const chunk = imageUrls.slice(i, i + CONCURRENCY_LIMIT);
                                const chunkPromises = chunk.map(async (url, index) => {
                                    const globalIndex = i + index;
                                    try {
                                        const blob = await fetchBlobWithXHR(url);
                                        const arrayBuffer = await blobToArrayBuffer(blob);
                                        return {
                                            url,
                                            index: globalIndex,
                                            data: arrayBuffer,
                                            size: blob.size,
                                            type: blob.type
                                        };
                                    } catch (err) {
                                        console.error(`[TokiSync-Worker] 이미지 다운로드 실패 (${url}):`, err);
                                        return {
                                            url,
                                            index: globalIndex,
                                            data: null,
                                            error: err.message
                                        };
                                    }
                                });

                                const chunkResults = await Promise.all(chunkPromises);
                                downloaded.push(...chunkResults);
                            }
                            return downloaded;
                        };

                        // 이미지 URL 목록을 추출하는 헬퍼 정의 (하이브리드 파싱)
                        const extractImageUrls = () => {
                            let imageSelector = '.view-padding img, .viewer-main img, #v_content img, .img-tag, .vw-imgs img';
                            if (viewerCfg.imageContainer) {
                                const itemSel = viewerCfg.imageItem || 'img';
                                imageSelector = viewerCfg.imageContainer.split(',').map(c => `${c.trim()} ${itemSel}`).join(', ');
                            }

                            // [v1.9.5 parity] viewer.exclude / viewer.remove — 광고/잡음 컨테이너 안의 img 제외
                            const excludeRule = viewerCfg.exclude || viewerCfg.remove;
                            const excludeSelectors = excludeRule
                                ? (Array.isArray(excludeRule) ? excludeRule : [excludeRule])
                                : [];
                            const matchesExclude = (img) => excludeSelectors.some(sel => {
                                try { return !!img.closest(sel); } catch (e) { return false; }
                            });

                            // [custom] viewer.urlExclude — URL substring/regex 차단 (광고 CDN 경로 등)
                            const urlExcludeRaw = viewerCfg.urlExclude || viewerCfg.urlBlocklist;
                            const urlExcludeList = urlExcludeRaw
                                ? (Array.isArray(urlExcludeRaw) ? urlExcludeRaw : [urlExcludeRaw])
                                : [];
                            const isUrlBlocked = (url) => {
                                if (!url) return false;
                                return urlExcludeList.some(p => {
                                    if (typeof p !== 'string') return false;
                                    if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
                                        try { return new RegExp(p.slice(1, -1)).test(url); } catch (e) { return false; }
                                    }
                                    return url.includes(p);
                                });
                            };

                            const all = Array.from(document.querySelectorAll(imageSelector));
                            const kept = excludeSelectors.length ? all.filter(img => !matchesExclude(img)) : all;
                            const droppedCount = all.length - kept.length;
                            if (droppedCount > 0) {
                                console.log(`🚫 [TokiSync-Worker] exclude 룰로 ${droppedCount}개 광고/잡음 이미지 제외`);
                            }

                            const rawUrls = kept
                                .map(img => img.src || img.dataset.src || img.dataset.original)
                                .filter(src => src && !src.includes('blank.gif') && !src.includes('loading.gif'))
                                .map(src => src.trim());
                            const urls = urlExcludeList.length ? rawUrls.filter(u => !isUrlBlocked(u)) : rawUrls;
                            const urlDropped = rawUrls.length - urls.length;
                            if (urlDropped > 0) {
                                console.log(`🚫 [TokiSync-Worker] urlExclude 룰로 ${urlDropped}개 URL 차단`);
                            }
                            return urls;
                        };

                        // 4) 1차 추출 및 다운로드 실행
                        let finalImages = extractImageUrls();
                        console.log(`🎯 [TokiSync-Worker] 1차 이미지 주소 ${finalImages.length}개 추출. 다운로드 개시...`);
                        let downloadedData = await runImageDownloads(finalImages);

                        // ── [iframe 명작 딥 폴백 로직 100% 재활용 이식] ──
                        // 만약 크기가 30KB 미만인 더미 플레이스홀더 이미지나 누락된 파일이 절반 이상인 경우 2차 정밀 재스크롤 구동
                        const suspiciousCount = downloadedData.filter(d => !d.data || d.size < 30000).length;
                        
                        if (suspiciousCount > finalImages.length / 2) {
                            console.warn(`⚠️ [Deep Fallback] 다수의 저용량/누락 이미지 감지 (${suspiciousCount}/${finalImages.length}). 2초 후 15초 강제 재스크롤 재시도!`);
                            await sleep(2000);
                            
                            // 2차 정밀 강제 징검다리 스크롤 기동 (15초)
                            await scrollToLoad(document, 15000, viewerCfg);
                            
                            // 최종 재추출 및 2차 재다운로드 단행
                            finalImages = extractImageUrls();
                            console.log(`🎯 [Deep Fallback] 2차 이미지 주소 ${finalImages.length}개 재추출. 최종 다운로드 재수행...`);
                            downloadedData = await runImageDownloads(finalImages);
                        }

                        console.log(`🎯 [TokiSync-Worker] 모든 이미지 수집 완료 (최종 성공: ${downloadedData.filter(d => d.data).length}/${downloadedData.length})`);

                        if (parentWin) {
                            parentWin.postMessage({
                                type: 'TOKI_MEDIA_DATA',
                                data: {
                                    novelId: location.pathname.split('/')[2] || '0',
                                    episodeId: location.pathname.split('/')[3] || '0',
                                    contentType: 'comic',
                                    content: null,
                                    images: downloadedData,
                                    nextUrl: document.querySelector('a#next_episode')?.href || null,
                                    timestamp: Date.now()
                                }
                            }, '*');
                        }
                    } catch (err) {
                        console.error('[TokiSync-Worker] 만화 이미지 수집 중 예외 발생:', err);
                    }
                }
            }
        });

        // 팝업 로딩 시 핸드셰이킹 시작
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            startReadyHeartbeat();
        } else {
            window.addEventListener('DOMContentLoaded', startReadyHeartbeat);
        }
        return; // 팝업 모드에서는 다운로더 UI 등 메인 스크립트 실행 조기 종료 (Early Exit)
    }
    
    // Viewer Config Injection (Zero-Config)
    if (location.hostname.includes('github.io') || location.hostname.includes('localhost') || location.hostname.includes('127.0.0.1')) {
        console.log("📂 TokiView (Frontend) detected. Injecting Config...");
        
        const config = getConfig();
        
        if (config.gasUrl && config.folderId) {
            // [Fix] Retry injection to handle timing issues (Viewer might not be ready)
            let retryCount = 0;
            const maxRetries = 5;
            let injectionConfirmed = false;
            let retryTimer = null;
            let pollTimer = null;
            
            // Check localStorage to verify injection success
            const checkInjection = () => {
                const storedUrl = localStorage.getItem('TOKI_API_URL');
                const storedGasId = localStorage.getItem('TOKI_GAS_ID');
                const storedId = localStorage.getItem('TOKI_ROOT_ID');
                const storedKey = localStorage.getItem('TOKI_API_KEY');
                
                // Matches if either URL matches or ID matches
                const urlMatches = (storedUrl === config.gasUrl || storedGasId === config.gasId);
                
                if (urlMatches && 
                    storedId === config.folderId && 
                    storedKey === (config.apiKey || '')) {
                    
                    injectionConfirmed = true;
                    if (retryTimer) clearTimeout(retryTimer);
                    if (pollTimer) clearInterval(pollTimer);
                    console.log("✅ Config injection confirmed (localStorage verified)");
                    return true;
                }
                return false;
            };
            
            const injectConfig = () => {
                if (injectionConfirmed) return; // Stop if already confirmed
                
                window.postMessage({ 
                    type: 'TOKI_CONFIG', 
                    url: config.gasUrl,
                    folderId: config.folderId,
                    apiKey: config.apiKey
                }, '*');
                
                console.log(`🚀 Config Injection Attempt ${retryCount + 1}/${maxRetries}:`, { 
                    gasUrl: config.gasUrl, 
                    apiKey: config.apiKey ? '***' : '(empty)'
                });

                retryCount++;
                if (retryCount < maxRetries && !injectionConfirmed) {
                    retryTimer = setTimeout(injectConfig, 1000);
                }
            };

            // Start polling localStorage (check every 200ms)
            pollTimer = setInterval(checkInjection, 200);
            
            // Timeout after 5 seconds
            setTimeout(() => {
                if (pollTimer) clearInterval(pollTimer);
                if (!injectionConfirmed) {
                    console.warn("⚠️ Config injection timeout (5s)");
                }
            }, 5000);

            // Start injection loop
            setTimeout(injectConfig, 500);

        } else {
            console.warn("⚠️ GAS URL or Folder ID missing. Please configure via menu.");
        }
        
        // API Proxy (CORS Bypass using GM_xmlhttpRequest)
        window.addEventListener('message', (event) => {
            // Security: Only accept from same origin
            if (event.source !== window) return;
            
            const msg = event.data;
            if (msg.type === 'TOKI_API_REQUEST') {
                console.log('[Proxy] Received API request:', msg.payload);
                
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: config.gasUrl,
                    data: JSON.stringify(msg.payload),
                    headers: { 'Content-Type': 'text/plain' },
                    onload: (response) => {
                        try {
                            const result = JSON.parse(response.responseText);
                            window.postMessage({
                                type: 'TOKI_API_RESPONSE',
                                requestId: msg.requestId,
                                result: result
                            }, '*');
                        } catch (e) {
                            window.postMessage({
                                type: 'TOKI_API_RESPONSE',
                                requestId: msg.requestId,
                                error: 'Parse error: ' + e.message
                            }, '*');
                        }
                    },
                    onerror: () => {
                        window.postMessage({
                            type: 'TOKI_API_RESPONSE',
                            requestId: msg.requestId,
                            error: 'Network error'
                        }, '*');
                    }
                });
            }
        });
        
        console.log("✅ API Proxy initialized (CORS bypass)");
    }
    // Delay main execution to prevent React Hydration errors (#418) on SPA sites
    const startMain = async () => {
        setTimeout(async () => {
            await main();
        }, 500); // 500ms buffer for hydration to complete
    };

    if (__TD >= 2) { // 레벨 2+: main() 실행
        if (document.readyState === 'complete') {
            startMain();
        } else {
            window.addEventListener('load', startMain);
        }
    }
})();
