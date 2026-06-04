export const LAN_LEASE_MAX_CONCURRENCY = 1;
export const LAN_ORPHAN_PROCESSING_GRACE_MS = 15000;

export function isLanLeaseQueueItem(item) {
  return !!(item && item.unitId);
}

export function extendLanQueueItem(baseItem, episode) {
  return {
    ...baseItem,
    unitId: episode.unitId || '',
    cover: episode.cover || '',
    meta: episode.meta || null,
    series: episode.series || episode.rootFolder || '',
    reported: false
  };
}

export function getLanQueueItemMetadataUpdates(existing, episode, novelTitle, workerStage) {
  const metadataUpdates = {};

  if (episode.unitId && existing.unitId !== episode.unitId) {
    metadataUpdates.unitId = episode.unitId;
    metadataUpdates.reported = false;
  }
  if (episode.cover && !existing.cover) metadataUpdates.cover = episode.cover;
  if (episode.meta && !existing.meta) metadataUpdates.meta = episode.meta;
  if ((episode.series || episode.rootFolder) && !existing.series) {
    metadataUpdates.series = episode.series || episode.rootFolder;
  }

  if (episode.unitId && (existing.status === 'completed' || existing.status === 'failed')) {
    Object.assign(metadataUpdates, {
      title: novelTitle,
      episodeTitle: episode.title,
      episodeUrl: episode.url,
      episodeNum: episode.episodeNum || '',
      folderId: episode.folderId || '',
      category: episode.category || existing.category || 'Manga',
      viewerCfg: episode.viewerCfg || {},
      rootFolder: episode.rootFolder || '',
      destination: episode.destination || 'local',
      novelFormat: episode.novelFormat || 'epub',
      matchedRule: episode.matchedRule || {},
      protocolDomain: episode.protocolDomain || '',
      unitId: episode.unitId,
      cover: episode.cover || existing.cover || '',
      meta: episode.meta || existing.meta || null,
      series: episode.series || episode.rootFolder || existing.series || '',
      status: 'pending',
      progressPercent: 0,
      stage: workerStage.INIT,
      retryCount: 0,
      reported: false,
      startedAt: 0,
      lastProgressAt: 0,
      completedAt: 0,
      errorMsg: ''
    });
  }

  return metadataUpdates;
}

export function recoverLanOrphanProcessing(queue, activeWorkers, updateQueueItem, workerStage, now = Date.now()) {
  let recovered = false;
  for (const item of queue) {
    if (!item || item.status !== 'processing' || activeWorkers.has(item.id)) continue;
    const startedAt = Number(item.startedAt || 0);
    if (startedAt && now - startedAt < LAN_ORPHAN_PROCESSING_GRACE_MS) continue;

    const nextRetry = (item.retryCount || 0) + 1;
    console.warn(`[Queue Scheduler] 워커 참조 유실 orphan processing 복구: ${item.episodeTitle || item.id} (${nextRetry}/3)`);
    updateQueueItem(item.id, {
      status: nextRetry >= 3 ? 'failed' : 'pending',
      retryCount: nextRetry,
      stage: nextRetry >= 3 ? workerStage.FAILED : workerStage.INIT,
      progressPercent: 0,
      startedAt: 0,
      lastProgressAt: 0,
      errorMsg: '워커 팝업 참조가 유실되어 자동 복구했습니다.'
    });
    recovered = true;
  }
  return recovered;
}

export function shouldBlockForLanQueuePolicy(nextItem, currentProcessing, maxConcurrency) {
  if (currentProcessing.length >= maxConcurrency) return true;
  if (!isLanLeaseQueueItem(nextItem)) return false;
  return currentProcessing.filter(isLanLeaseQueueItem).length >= LAN_LEASE_MAX_CONCURRENCY;
}

export function focusLanWorkerPopup(popupRef, context = 'worker') {
  try {
    if (popupRef && !popupRef.closed && typeof popupRef.focus === 'function') {
      popupRef.focus();
      console.log(`[Queue Scheduler] ${context} 팝업 포커스 신호 전송`);
      return true;
    }
  } catch (err) {
    console.warn(`[Queue Scheduler] ${context} 팝업 포커스 실패:`, err);
  }
  return false;
}

export function markLanPopupSlotReused(closedCounts, oldId, newId) {
  closedCounts.delete(oldId);
  closedCounts.set(newId, 0);
}
