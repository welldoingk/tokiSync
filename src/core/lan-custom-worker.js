import { updateQueueItem, WORKER_STAGE, activeWorkers, runSchedulerOnce } from './queue.js';

export const LAN_WORKER_STALL_TIMEOUTS = {
    PAGE_LOAD: 90000,
    // DOM_READY 구간(waitForContent·TTS 폴링·차단페이지 재시도)은 진행 IPC를 거의 보내지 않고
    // 높은 scanSpeed 배율에선 단일 단계가 75초에 근접할 수 있어, 오탐 종료를 막도록 120초로 완화.
    DOM_READY: 120000,
    // SCROLL 구간은 scrollToLoad의 heartbeat(WORKER_PROGRESS 재전송)로 lastProgressAt이 갱신되므로
    // 90초를 유지해도 정상 워커는 종료되지 않고, 진짜 멈춘 워커만 빠르게 복구된다.
    SCROLL: 90000,
    PROGRESS: 180000,
    ORPHAN_PROCESSING_GRACE: 15000
};

export function isLanLeaseQueueItem(item) {
    return !!(item && item.unitId);
}

export function focusLanWorkerWindow(workerRef, context = 'worker') {
    try {
        if (workerRef && !workerRef.closed && typeof workerRef.focus === 'function') {
            workerRef.focus();
            console.log(`[WorkerController] ${context} 워커 팝업 포커스 신호 전송`);
            return true;
        }
    } catch (err) {
        console.warn(`[WorkerController] ${context} 워커 팝업 포커스 실패:`, err);
    }
    return false;
}

export function kickLanRemotePoll(reason, queueId) {
    try {
        window.dispatchEvent(new CustomEvent('toki:remote-kick', {
            detail: { reason, queueId, at: Date.now() }
        }));
    } catch (err) {
        console.warn('[WorkerController] 원격 폴링 깨움 신호 실패:', err);
    }
}

export function formatLanStageText(stage, payload = {}, workerStage = WORKER_STAGE) {
    if (stage === workerStage.DOM_READY) return '페이지 로딩';
    if (stage === workerStage.SCROLLING) return '스크롤 스캔';
    if (stage === workerStage.PARSING) return '미디어 파싱';
    if (stage === workerStage.DOWNLOADING) return '다운로드';
    if (stage === workerStage.UPLOADING) {
        return payload.savedPath ? `${payload.destLabel || '드라이브'} 저장: ${payload.savedPath}` : '드라이브 저장';
    }
    if (stage === workerStage.COMPLETED) return '완료';
    return '대기 중';
}

function shortText(value, maxLen = 90) {
    const text = value == null ? '' : String(value);
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function formatLanDiagnosticSummary(diagnostics) {
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

export function shouldLogLanDiagnosticPhase(phase) {
    return /timeout|empty|captcha|cloudflare|suspicious|error|stalled/i.test(phase || '');
}

export function recoverStalledLanBatchWorker(id, popupRef, item, reason, logger, closedCounts) {
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
    const diagnosticSummary = formatLanDiagnosticSummary(item.diagnostics);
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
    logger.warn(`[배치 정체복구] [${title}] ${errorMsg} -> ${failed ? '실패 처리' : '재시도'} (${nextRetry}/3)`, 'Queue');
    if (failed) kickLanRemotePoll('worker-finished', id);
    runSchedulerOnce();
}

export function shouldCloseLanTerminalPopup(item, pendingExists) {
    return !pendingExists && !isLanLeaseQueueItem(item);
}
