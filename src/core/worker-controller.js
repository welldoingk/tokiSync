/**
 * tokiSync - Unified Worker Controller
 * Manages single popup lifecycle and IPC routing for sequential download mode.
 */

import { fetchNovelTextViaApi } from './novel-decryptor.js';
import { registerIpcListener, sendToWorker } from './ipc-broker.js';
import { updateQueueItem, WORKER_STAGE, activeWorkers, getQueue, runSchedulerOnce } from './queue.js';
import { LogBox } from './ui.js';
import { getConfig } from './config.js';

// Reference for the single worker popup (used in sequential mode)
let activeWorkerRef = null;

function isLeaseQueueItem(item) {
    return !!(item && item.unitId);
}

function focusWorkerWindow(workerRef, context = 'worker') {
    try {
        if (workerRef && !workerRef.closed && typeof workerRef.focus === 'function') {
            workerRef.focus();
            console.log(`[WorkerController] 🔎 ${context} 워커 팝업 포커스 신호 전송`);
            return true;
        }
    } catch (err) {
        console.warn(`[WorkerController] ${context} 워커 팝업 포커스 실패:`, err);
    }
    return false;
}

function kickRemotePoll(reason, queueId) {
    try {
        window.dispatchEvent(new CustomEvent('toki:remote-kick', {
            detail: { reason, queueId, at: Date.now() }
        }));
    } catch (err) {
        console.warn('[WorkerController] 원격 폴링 깨움 신호 실패:', err);
    }
}

const PAGE_LOAD_STALL_TIMEOUT_MS = 90000;
const WORKER_PROGRESS_STALL_TIMEOUT_MS = 180000;
const ORPHAN_PROCESSING_GRACE_MS = 15000;

function shortText(value, maxLen = 90) {
    const text = value == null ? '' : String(value);
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function formatDiagnosticSummary(diagnostics) {
    if (!diagnostics) return '';
    const nav = diagnostics.nav ? `nav=${diagnostics.nav.type}/${diagnostics.nav.duration}ms` : '';
    const flags = [
        diagnostics.cloudflare ? 'cloudflare' : '',
        diagnostics.captcha ? 'captcha' : '',
        diagnostics.hasFocus === false ? 'no-focus' : '',
        diagnostics.visibility && diagnostics.visibility !== 'visible' ? `visibility=${diagnostics.visibility}` : ''
    ].filter(Boolean).join(',');
    return [
        `phase=${diagnostics.phase || 'unknown'}`,
        `ready=${diagnostics.readyState || '-'}`,
        flags ? `flags=${flags}` : '',
        `body=${diagnostics.bodyTextLen || 0}`,
        `container=${diagnostics.containers || 0}/${diagnostics.containerChildren || 0}`,
        `img=${diagnostics.validImgCount || 0}/${diagnostics.imgCount || 0}`,
        `complete=${diagnostics.completeImgCount || 0}`,
        `dummy=${diagnostics.dummyImgCount || 0}`,
        `lazy=${diagnostics.lazyAttrCount || 0}`,
        diagnostics.ttsTextLen ? `tts=${diagnostics.ttsTextLen}` : '',
        diagnostics.novelTextLen ? `novel=${diagnostics.novelTextLen}` : '',
        nav,
        diagnostics.title ? `title="${shortText(diagnostics.title, 60)}"` : '',
        diagnostics.firstImg ? `firstImg="${shortText(diagnostics.firstImg, 90)}"` : ''
    ].filter(Boolean).join(' · ');
}

function shouldLogDiagnosticPhase(phase) {
    return /timeout|empty|captcha|cloudflare|suspicious|error|stalled/i.test(phase || '');
}

function recoverStalledBatchWorker(id, popupRef, item, reason, logger, closedCounts) {
    try {
        const actualRef = popupRef && (popupRef.ref || popupRef);
        if (actualRef && !actualRef.closed) actualRef.close();
    } catch (err) {
        console.warn(`[WorkerController] [배치] 정체 워커 close 실패 (${id}):`, err);
    }

    activeWorkers.delete(id);
    if (closedCounts) closedCounts.delete(id);

    const nextRetry = (item.retryCount || 0) + 1;
    const failed = nextRetry >= 3;
    const diagnosticSummary = formatDiagnosticSummary(item.diagnostics);
    const errorMsg = diagnosticSummary ? `${reason}; ${diagnosticSummary}` : reason;
    updateQueueItem(id, {
        status: failed ? 'failed' : 'pending',
        retryCount: nextRetry,
        stage: failed ? WORKER_STAGE.FAILED : WORKER_STAGE.INIT,
        progressPercent: 0,
        startedAt: 0,
        lastProgressAt: 0,
        errorMsg
    });

    const title = item.episodeTitle || item.title || id;
    logger.warn(`[배치 정체복구] [${title}] ${errorMsg} → ${failed ? '실패 처리' : '재시도'} (${nextRetry}/3)`, 'Queue');
    if (failed) kickRemotePoll('worker-finished', id);
    runSchedulerOnce();
}

/**
 * Close active single worker popup window
 */
export function closeActiveWorker() {
    if (activeWorkerRef && !activeWorkerRef.closed) {
        console.log('[WorkerController] 단일 워커 팝업 세션 수동 폐쇄');
        activeWorkerRef.close();
    }
    activeWorkerRef = null;
}

/**
 * Run a single collection attempt via the Worker Popup
 */
async function fetchMediaViaWorkerSingleAttempt(episodeUrl, targetType = 'novel', config = {}) {
    const timeoutDuration = config.timeout || 45000;
    const logger = LogBox.getInstance();

    return new Promise((resolve) => {
        let timeoutId = null;
        let handshakeTimeoutId = null;
        let cleanupIpc = null;
        let livenessInterval = null;

        const cleanup = () => {
            if (cleanupIpc) { cleanupIpc(); cleanupIpc = null; }
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
            if (handshakeTimeoutId) { clearTimeout(handshakeTimeoutId); handshakeTimeoutId = null; }
            if (livenessInterval) { clearInterval(livenessInterval); livenessInterval = null; }
        };

        // Register consolidated IPC Listener
        cleanupIpc = registerIpcListener(async (msg) => {
            const { type, payload } = msg;

            // 1. Handshake Ready Received ➡️ Inject Action Instructions
            if (type === 'WORKER_READY') {
                if (handshakeTimeoutId) {
                    console.log('[WorkerController] 🎉 단일 워커 핸드셰이킹 성공 (30초 세이프티 해제)');
                    clearTimeout(handshakeTimeoutId);
                    handshakeTimeoutId = null;
                }

                if (activeWorkerRef && !activeWorkerRef.closed) {
                    console.log(`[WorkerController] 📢 READY 수신 ➡️ 지시 주입 (유형: ${targetType})`);
                    focusWorkerWindow(activeWorkerRef, '단일');
                    
                    // Inject metadata bundle for local self-contained execution
                    sendToWorker(activeWorkerRef, 'START_EXTRACTION', {
                        queueId: config.queueId || `${location.pathname.split('/')[2] || '0'}_${location.pathname.split('/')[3] || '0'}`,
                        targetType: targetType,
                        seriesTitle: config.seriesTitle || 'UnknownSeries',
                        rootFolder: config.rootFolder || config.seriesTitle || 'UnknownSeries', // Explicit normalized drive root folder name
                        episodeTitle: config.episodeTitle || 'UnknownEpisode',
                        episodeNum: config.episodeNum || '0000',
                        folderId: config.folderId || '',
                        destination: config.destination || 'local',
                        novelFormat: config.novelFormat || 'epub',
                        matchedRule: config.matchedRule || {},
                        protocolDomain: config.protocolDomain || window.location.origin,
                        scanSpeedMultiplier: config.scanSpeedMultiplier || 1.0,
                        localNameTemplate: config.localNameTemplate || "{number} - {title}",
                        localEpisodePadding: config.localEpisodePadding || "4"
                    });
                }
            }

            // 2. CAPTCHA detected ➡️ Extend timeout to 5 minutes
            if (type === 'CAPTCHA_DETECTED') {
                console.warn('[WorkerController] ⚠️ 캡차/CF 감지 ➡️ 타임아웃 5분으로 확장');
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = setTimeout(() => {
                        cleanup();
                        console.error('[WorkerController] 캡차 타임아웃 (5분)');
                        closeActiveWorker();
                        resolve(false);
                    }, 300000);
                }
            }

            // 3. Child Progress reporting ➡️ Forward to logger
            if (type === 'WORKER_PROGRESS') {
                const { percent, stage } = payload;
                
                let stageText = '대기 중';
                if (stage === WORKER_STAGE.DOM_READY) stageText = '페이지 로딩';
                else if (stage === WORKER_STAGE.SCROLLING) stageText = '스크롤 스캔';
                else if (stage === WORKER_STAGE.PARSING) stageText = '미디어 파싱';
                else if (stage === WORKER_STAGE.DOWNLOADING) stageText = '다운로드';
                else if (stage === WORKER_STAGE.UPLOADING) stageText = payload.savedPath ? `${payload.destLabel || '드라이브'} 저장: ${payload.savedPath}` : '드라이브 저장';
                else if (stage === WORKER_STAGE.COMPLETED) stageText = '완료';

                logger.log(`[수집 진행] [${config.episodeTitle || '에피소드'}] -> ${stageText} (${Math.round(percent)}%)`, 'Downloader');
            }

            // 4. Task completed successfully
            if (type === 'TASK_COMPLETED') {
                if (payload && payload.savedPath) logger.log(`✅ 저장 완료: [${payload.destLabel || ''}] ${payload.savedPath}`, 'success', 'Downloader');
                cleanup();
                
                // Add WAF jitter delay (3~5s) to stay stealthy
                const jitterDelay = 3000 + Math.random() * 2000;
                console.log(`[WorkerController] WAF 지터 대기 (${(jitterDelay / 1000).toFixed(2)}초)...`);
                await new Promise(r => setTimeout(r, jitterDelay));
                
                resolve(true); // Success
            }

            // 5. Task failed with error
            if (type === 'TASK_FAILED') {
                cleanup();
                console.error(`[WorkerController] 자식 워커가 에러를 보고함: ${payload.errorMsg}`);
                resolve(false); // Fail
            }
        });

        // 팝업 수동 종료 실시간 감시 타이머 (Liveness Guard)
        livenessInterval = setInterval(() => {
            if (activeWorkerRef && activeWorkerRef.closed) {
                console.warn('[WorkerController] ⚠️ 단일 워커 팝업 수동 종료 감지 (즉시 예외 복구)');
                cleanup();
                closeActiveWorker();
                resolve(false);
            }
        }, 1000);

        // 30s Handshake Safety (Fast-fail if redirect blocked or popup frozen)
        handshakeTimeoutId = setTimeout(() => {
            cleanup();
            console.error('[WorkerController] ⚠️ 30초 핸드셰이킹 타임아웃 (리다이렉션 차단 의심)');
            closeActiveWorker();
            resolve(false);
        }, 30000);

        // General Timeout
        timeoutId = setTimeout(() => {
            cleanup();
            console.error(`[WorkerController] 수집 타임아웃 (${timeoutDuration / 1000}초)`);
            closeActiveWorker();
            resolve(false);
        }, timeoutDuration);

        // Start or Recycle Popup window
        try {
            if (activeWorkerRef && !activeWorkerRef.closed) {
                console.log('[WorkerController] 기존 워커 팝업 재사용 (location.replace):', episodeUrl);
                try {
                    activeWorkerRef.location.replace(episodeUrl);
                    activeWorkerRef.name = 'tokisync-novel-worker';
                } catch (replaceErr) {
                    console.warn('[WorkerController] location.replace 차단 ➡️ href 폴백:', replaceErr);
                    activeWorkerRef.location.href = episodeUrl;
                    activeWorkerRef.name = 'tokisync-novel-worker';
                }
                focusWorkerWindow(activeWorkerRef, '단일 재사용');
            } else {
                console.log('[WorkerController] 신규 단일 워커 팝업 기동:', episodeUrl);
                activeWorkerRef = window.open(
                    episodeUrl,
                    'tokisync-novel-worker',
                    'width=400,height=600,left=0,top=0,noopener=false,scrollbars=yes,resizable=yes'
                );
                if (!activeWorkerRef) {
                    throw new Error('브라우저 팝업 차단이 감지되었습니다.');
                }
                focusWorkerWindow(activeWorkerRef, '단일 신규');
            }
        } catch (err) {
            cleanup();
            console.error('[WorkerController] 워커 팝업 기동 실패:', err);
            closeActiveWorker();
            alert(`[TokiSync 팝업 차단 알림]\n\n브라우저 주소창 우측에서 [팝업 및 리다이렉트 항상 허용]으로 설정해 주셔야 합니다.\n(오류: ${err.message})`);
            resolve(false);
        }
    });
}

/**
 * Manage retries for worker popup collection
 */
async function fetchMediaViaWorker(episodeUrl, targetType = 'novel', config = {}) {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`[WorkerController] 🚀 수집 시도 (${attempt}/${MAX_RETRIES}) — URL: ${episodeUrl}`);

        if (attempt > 1) {
            console.warn('[WorkerController] ⚠️ 이전 시도 실패 — 워커 세션 재설정');
            closeActiveWorker();
            await new Promise(r => setTimeout(r, 1500));
        }

        try {
            const success = await fetchMediaViaWorkerSingleAttempt(episodeUrl, targetType, config);
            if (success) {
                console.log(`[WorkerController] 🎉 수집 성공 (${attempt}/${MAX_RETRIES})`);
                return true; // Return success status
            }
            console.warn(`[WorkerController] ⚠️ 수집 실패 (${attempt}/${MAX_RETRIES}) — 작업 불완성`);
        } catch (err) {
            console.error(`[WorkerController] ❌ 수집 예외 (${attempt}/${MAX_RETRIES}):`, err);
        }
    }

    console.error(`[WorkerController] 🛑 총 ${MAX_RETRIES}회 전부 실패 — URL: ${episodeUrl}`);
    return false;
}

// =============================================================
// 공개 진입점 (Gateway) — downloader.js 전용
// =============================================================

/**
 * 소설 본문 수집 (Plan B: 자립형 팝업 ➡️ Plan C: API 복호화 폴백)
 */
export async function fetchNovelText(episodeUrl, config = {}) {
    console.log('[WorkerController] 소설 수집 개시 (Plan B — 자립형 팝업)');
    const success = await fetchMediaViaWorker(episodeUrl, 'novel', config);

    if (success) return true; // Success (Worker already saved it!)

    // Plan C Fallback: Local API Decryption (if decryptApi configuration exists)
    if (config.decryptApi || config.endpoint) {
        console.warn('[WorkerController] Plan B 실패 ➡️ Plan C(API 복호화) 로컬 폴백 시도');
        const content = await fetchNovelTextViaApi(episodeUrl, config.decryptApi || config);
        if (content) {
            // Since API fallback runs in parent, parent must write it
            return content; // Return raw text so downloader.js can package and save
        }
    }

    return null;
}

/**
 * 만화/웹툰 이미지 수집 (Plan B: 자립형 팝업)
 */
export async function fetchComicImages(episodeUrl, config = {}) {
    console.log('[WorkerController] 만화 이미지 수집 개시 (Plan B — 자립형 팝업)');
    return await fetchMediaViaWorker(episodeUrl, 'comic', config);
}

/**
 * 🚦 배치/드라이브 전용 자율 분산형 멀티 워커 제어 엔진 (v1.21.0)
 * 여러 개의 자식 팝업 창으로부터 오는 IPC 이벤트를 독립적으로 라우팅하여 멀티태스킹 수행
 */
export function initBatchWorkerController() {
    const logger = LogBox.getInstance();
    
    if (window.tokisync_batch_controller_initialized) return;
    window.tokisync_batch_controller_initialized = true;

    console.log('[WorkerController] 🚦 [배치 모드] 백그라운드 영속성 IPC 라우터 활성화 완료');

    // 정기적인 자식 팝업 닫힘 실시간 감시 (Batch Liveness Guard)
    const batchClosedCounts = new Map();
    setInterval(() => {
        const queue = getQueue();
        const now = Date.now();
        for (const [id, popupRef] of activeWorkers.entries()) {
            const actualRef = popupRef && (popupRef.ref || popupRef);
            const item = queue.find(i => i.id === id);
            if (actualRef && actualRef.closed) {
                const closedCount = (batchClosedCounts.get(id) || 0) + 1;
                batchClosedCounts.set(id, closedCount);

                if (closedCount >= 5) {
                    console.warn(`[WorkerController] ⚠️ [배치] 자식 팝업 수동 종료 확정: ${id}`);
                    activeWorkers.delete(id);
                    batchClosedCounts.delete(id);

                    const item = queue.find(i => i.id === id);
                    if (item && item.status === 'processing') {
                        const nextRetry = (item.retryCount || 0) + 1;
                        updateQueueItem(id, {
                            status: nextRetry >= 3 ? 'failed' : 'pending',
                            retryCount: nextRetry,
                            errorMsg: '자식 팝업 창이 비정상적으로 강제 종료되었습니다.'
                        });
                        logger.error(`❌ [배치 수동종료] [${item.episodeTitle}] 자식 팝업이 종료되어 복구를 단행합니다.`, 'Queue');
                        if (nextRetry >= 3) kickRemotePoll('worker-finished', id);
                        runSchedulerOnce();
                    }
                }
            } else {
                batchClosedCounts.set(id, 0);

                if (item && item.status === 'processing') {
                    const startedAt = Number(item.startedAt || 0);
                    if (!startedAt) {
                        updateQueueItem(id, { startedAt: now, lastProgressAt: now });
                        continue;
                    }

                    const lastProgressAt = Number(item.lastProgressAt || startedAt);
                    const percent = Number(item.progressPercent || 0);
                    const stage = item.stage || WORKER_STAGE.INIT;
                    const pageLoading = stage === WORKER_STAGE.INIT || stage === WORKER_STAGE.DOM_READY;

                    if (pageLoading && percent < 20 && now - startedAt > PAGE_LOAD_STALL_TIMEOUT_MS) {
                        recoverStalledBatchWorker(
                            id,
                            popupRef,
                            item,
                            `페이지 로딩 정체 ${Math.round((now - startedAt) / 1000)}초`,
                            logger,
                            batchClosedCounts
                        );
                    } else if (percent < 100 && now - lastProgressAt > WORKER_PROGRESS_STALL_TIMEOUT_MS) {
                        recoverStalledBatchWorker(
                            id,
                            popupRef,
                            item,
                            `진행률 정체 ${Math.round((now - lastProgressAt) / 1000)}초`,
                            logger,
                            batchClosedCounts
                        );
                    }
                }
            }
        }

        for (const item of queue) {
            if (!item || item.status !== 'processing' || activeWorkers.has(item.id)) continue;
            const startedAt = Number(item.startedAt || 0);
            if (startedAt && now - startedAt < ORPHAN_PROCESSING_GRACE_MS) continue;
            recoverStalledBatchWorker(
                item.id,
                null,
                item,
                `워커 참조 유실 orphan processing${startedAt ? ` ${Math.round((now - startedAt) / 1000)}초` : ''}`,
                logger,
                batchClosedCounts
            );
        }
    }, 2000);

    registerIpcListener(async (msg) => {
        const { type, payload, sourceEvent } = msg;
        if (!sourceEvent || !sourceEvent.source) return;

        // 1. WORKER_READY: 자식 워커 핸드셰이킹 수신
        if (type === 'WORKER_READY') {
            const { targetUrl } = payload || {};
            let matchedId = null;

            // 1차: activeWorkers의 window 참조 비교
            for (const [id, popupRef] of activeWorkers.entries()) {
                if (popupRef === sourceEvent.source) {
                    matchedId = id;
                    break;
                }
            }

            // 2차: URL 기반 매칭 폴백 (리다이렉션으로 주소가 완전히 틀어졌을 때 복구)
            if (!matchedId && targetUrl) {
                const queue = getQueue();
                const matchedItem = queue.find(item => 
                    (item.status === 'pending' || item.status === 'processing') && 
                    item.episodeUrl === targetUrl
                );
                if (matchedItem) {
                    matchedId = matchedItem.id;
                    // 최신 Window 참조로 activeWorkers 즉시 복원 갱신
                    activeWorkers.set(matchedId, sourceEvent.source);
                    console.log(`[WorkerController] ♻️ URL 매칭 성공 ➡️ Window 참조 복원 갱신 (ID: ${matchedId})`);
                }
            }

            if (matchedId) {
                const queue = getQueue();
                const item = queue.find(i => i.id === matchedId);
                
                if (item) {
                    console.log(`[WorkerController] 📢 [배치] READY 수신 (ID: ${matchedId}) ➡️ START_EXTRACTION 주입`);
                    focusWorkerWindow(sourceEvent.source, `배치 ${matchedId}`);
                    
                    sendToWorker(sourceEvent.source, 'START_EXTRACTION', {
                        queueId: item.id,
                        targetType: (item.category === 'Novel' || item.category === 'novel') ? 'novel' : 'comic',
                        seriesTitle: item.title,
                        rootFolder: item.rootFolder || item.title || 'UnknownSeries',
                        episodeTitle: item.episodeTitle,
                        episodeNum: item.episodeNum,
                        folderId: item.folderId || '',
                        destination: item.destination || 'local',
                        novelFormat: item.novelFormat || 'epub',
                        matchedRule: item.matchedRule || {},
                        protocolDomain: item.protocolDomain || window.location.origin,
                        scanSpeedMultiplier: getConfig().scanSpeed,
                        localNameTemplate: getConfig().localNameTemplate || "{number} - {title}",
                        localEpisodePadding: getConfig().localEpisodePadding || "4",
                        cover: item.cover || '',
                        meta: item.meta || null
                    });
                }
            } else {
                console.warn('[WorkerController] [배치] WORKER_READY 수신했으나 매칭되는 activeWorkers 항목을 찾지 못했습니다.', targetUrl);
            }
        }

        // 2. CAPTCHA_DETECTED: WAF/보안 방어막 대기 상태
        if (type === 'CAPTCHA_DETECTED') {
            const { queueId } = payload || {};
            let matchedId = queueId;

            if (!matchedId) {
                for (const [id, popupRef] of activeWorkers.entries()) {
                    if (popupRef === sourceEvent.source) { matchedId = id; break; }
                }
            }

            if (matchedId) {
                console.warn(`[WorkerController] ⚠️ [배치] WAF 캡차 차단막 감지 (ID: ${matchedId})`);
                const queue = getQueue();
                const item = queue.find(i => i.id === matchedId);
                if (item) {
                    logger.log(`⚠️ [캡차 대기] [${item.episodeTitle}] 브라우저 창에서 보안 해제를 수행해 주세요.`, 'Downloader');
                }
            }
        }

        // 3. WORKER_DIAGNOSTICS: 페이지 로딩/DOM/lazy-load 상태 진단 수집
        if (type === 'WORKER_DIAGNOSTICS') {
            const { queueId, phase, diagnostics } = payload || {};
            let matchedId = queueId;

            if (!matchedId) {
                for (const [id, popupRef] of activeWorkers.entries()) {
                    if (popupRef === sourceEvent.source) { matchedId = id; break; }
                }
            }

            if (matchedId) {
                const queue = getQueue();
                const item = queue.find(i => i.id === matchedId);
                const diag = { phase: phase || 'unknown', ...(diagnostics || {}) };
                updateQueueItem(matchedId, { diagnostics: diag, lastDiagnosticAt: Date.now() });
                const summary = formatDiagnosticSummary(diag);
                if (item && summary && shouldLogDiagnosticPhase(phase)) {
                    logger.warn(`[진단] [${item.episodeTitle || item.title || matchedId}] ${summary}`, 'WorkerDiag');
                } else if (summary) {
                    console.log(`[WorkerController] [진단] ${matchedId}: ${summary}`);
                }
            }
        }

        // 4. WORKER_PROGRESS: 자식 워커 실시간 진행률 UI 반영
        if (type === 'WORKER_PROGRESS') {
            const { percent, stage, queueId } = payload || {};
            let matchedId = queueId;

            if (!matchedId) {
                for (const [id, popupRef] of activeWorkers.entries()) {
                    if (popupRef === sourceEvent.source) { matchedId = id; break; }
                }
            }

            if (matchedId) {
                const queue = getQueue();
                const item = queue.find(i => i.id === matchedId);
                if (item) {
                    updateQueueItem(matchedId, { progressPercent: percent, stage: stage, lastProgressAt: Date.now() });
                    
                    let stageText = '대기 중';
                    if (stage === WORKER_STAGE.DOM_READY) stageText = '페이지 로딩';
                    else if (stage === WORKER_STAGE.SCROLLING) stageText = '스크롤 스캔';
                    else if (stage === WORKER_STAGE.PARSING) stageText = '미디어 파싱';
                    else if (stage === WORKER_STAGE.DOWNLOADING) stageText = '다운로드';
                    else if (stage === WORKER_STAGE.UPLOADING) stageText = payload.savedPath ? `${payload.destLabel || '드라이브'} 저장: ${payload.savedPath}` : '드라이브 저장';
                    else if (stage === WORKER_STAGE.COMPLETED) stageText = '완료';

                    logger.log(`[수집 진행] [${item.episodeTitle}] -> ${stageText} (${Math.round(percent)}%)`, 'Downloader');
                    logger.updateProgressUI();
                }
            }
        }

        // 5. TASK_COMPLETED: 자식 워커 수집 및 드라이브 저장 정상 완료
        if (type === 'TASK_COMPLETED') {
            const { queueId } = payload || {};
            let matchedId = queueId;

            if (!matchedId) {
                for (const [id, popupRef] of activeWorkers.entries()) {
                    if (popupRef === sourceEvent.source) { matchedId = id; break; }
                }
            }

            if (matchedId) {
                console.log(`[WorkerController] 🎉 [배치] 수집 완료 (ID: ${matchedId})`);
                if (payload && payload.savedPath) logger.log(`✅ 저장 완료: [${payload.destLabel || ''}] ${payload.savedPath}`, 'success', 'Downloader');
                
                const popupRef = activeWorkers.get(matchedId);
                if (popupRef && !popupRef.closed) {
                    const queue = getQueue();
                    const item = queue.find(i => i.id === matchedId);
                    const pendingExists = queue.some(i => i.status === 'pending');
                    // lease 모드는 다음 poll에서 새 unit이 들어올 수 있으므로 completed 팝업을 릴레이 슬롯으로 보존한다.
                    // 그렇지 않으면 leaseMax 단위로 로컬 pending이 0이 되는 순간 창을 닫고, 다음 lease 때 새 팝업을 계속 만든다.
                    if (!pendingExists && !isLeaseQueueItem(item)) {
                        popupRef.close();
                        activeWorkers.delete(matchedId);
                    }
                } else {
                    activeWorkers.delete(matchedId);
                }
                
                updateQueueItem(matchedId, { status: 'completed', progressPercent: 100, stage: WORKER_STAGE.COMPLETED });
                logger.updateProgressUI();
                kickRemotePoll('worker-finished', matchedId);

                // 다음 대기 항목 릴레이 스케줄링
                runSchedulerOnce();
            }
        }

        // 6. TASK_FAILED: 예외 및 복구 불능 실패 보고
        if (type === 'TASK_FAILED') {
            const { errorMsg, queueId } = payload || {};
            let matchedId = queueId;

            if (!matchedId) {
                for (const [id, popupRef] of activeWorkers.entries()) {
                    if (popupRef === sourceEvent.source) { matchedId = id; break; }
                }
            }

            if (matchedId) {
                console.error(`[WorkerController] ❌ [배치] 수집 실패 (ID: ${matchedId}): ${errorMsg}`);
                
                const popupRef = activeWorkers.get(matchedId);
                if (popupRef && !popupRef.closed) {
                    const queue = getQueue();
                    const item = queue.find(i => i.id === matchedId);
                    const pendingExists = queue.some(i => i.status === 'pending');
                    // lease 항목 실패도 재시도/재임대 흐름에서 같은 팝업 슬롯을 재사용할 수 있게 보존한다.
                    if (!pendingExists && !isLeaseQueueItem(item)) {
                        popupRef.close();
                        activeWorkers.delete(matchedId);
                    }
                } else {
                    activeWorkers.delete(matchedId);
                }

                const queue = getQueue();
                const item = queue.find(i => i.id === matchedId);
                if (item) {
                    const nextRetry = (item.retryCount || 0) + 1;
                    updateQueueItem(matchedId, {
                        status: nextRetry >= 3 ? 'failed' : 'pending',
                        retryCount: nextRetry,
                        errorMsg: errorMsg || '자식 워커가 에러를 보고함'
                    });
                    logger.updateProgressUI();
                    if (nextRetry >= 3) {
                        kickRemotePoll('worker-finished', matchedId);
                    }
                }

                // 다음 대기 항목 릴레이 스케줄링
                runSchedulerOnce();
            }
        }
    });
}
