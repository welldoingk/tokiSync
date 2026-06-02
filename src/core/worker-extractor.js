/**
 * tokiSync - Self-contained Worker Extractor
 * Executes extraction, packaging, and direct Drive uploading inside the child popup.
 */

import { sleep, waitForContent, scrollToLoad, fetchBlobWithXHR, blobToArrayBuffer, saveFile } from './utils.js';
import { EpubBuilder } from './epub.js';
import { CbzBuilder } from './cbz.js';
import { TxtBuilder } from './txt.js';
import { updateQueueItem, WORKER_STAGE } from './queue.js';
import { registerIpcListener, sendToParent } from './ipc-broker.js';
import { GenericParser } from './parsers/GenericParser.js';
import { fetchNovelTextViaApi } from './novel-decryptor.js';

// Define localized stage reporting helper
function reportProgress(queueId, percent, stage, extra = {}) {
    updateQueueItem(queueId, {
        progressPercent: Math.min(100, Math.max(0, Math.round(percent))),
        stage: stage
    });
    // Send lightweight progress update to parent UI (extra: destLabel/savedPath 등 동봉)
    sendToParent('WORKER_PROGRESS', {
        queueId,
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        stage,
        ...extra
    });
}

function queryAllSafe(doc, selector) {
    try { return selector ? Array.from(doc.querySelectorAll(selector)) : []; }
    catch { return []; }
}

function collectPageDiagnostics(viewerCfg = {}, extra = {}) {
    const doc = document;
    const imageItem = viewerCfg.imageItem || 'img';
    const imageSelector = viewerCfg.imageContainer
        ? viewerCfg.imageContainer.split(',').map(c => `${c.trim()} ${imageItem}`).join(', ')
        : '.view-padding div img, .viewer-main img, #v_content img, .img-tag, img';
    const containerSelector = viewerCfg.imageContainer || '.view-padding, .viewer-main, #v_content';
    const novelSelector = viewerCfg.novelContent || '#novel_content';
    const allImgs = queryAllSafe(doc, imageSelector);
    const containers = queryAllSafe(doc, containerSelector);
    const srcOf = (img) => img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original') || '';
    const isDummySrc = (src) => {
        if (!src || src.startsWith('data:image')) return true;
        const lower = src.toLowerCase();
        return ['blank.gif', 'loading.gif', 'loading-image.gif', 'pixel.gif', 'spacer.gif', 'transparent.gif', '1x1.gif', 'dot.gif']
            .some(p => lower.includes(p));
    };
    const srcs = allImgs.map(srcOf);
    const validImgs = srcs.filter(src => src && !isDummySrc(src));
    const novelEl = queryAllSafe(doc, novelSelector)[0] || null;
    const ttsText = typeof window.__novelTTSText === 'string' ? window.__novelTTSText : '';
    const cf = !!(
        doc.title.includes('Just a moment') ||
        doc.getElementById('cf-challenge-running') ||
        doc.querySelector('.cf-browser-verification') ||
        doc.getElementById('challenge-running')
    );
    const captcha = !!(
        doc.querySelector('fieldset#captcha, fieldset.captcha') ||
        doc.querySelector('img.captcha_img, img[src*="kcaptcha_image.php"]') ||
        doc.querySelector('form[action*="captcha_check.php"]') ||
        doc.querySelector('iframe[src*="hcaptcha"]') ||
        doc.querySelector('.g-recaptcha')
    );

    let nav = null;
    try {
        const entry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        if (entry) {
            nav = {
                type: entry.type,
                duration: Math.round(entry.duration || 0),
                domContentLoaded: Math.round(entry.domContentLoadedEventEnd || 0),
                loadEnd: Math.round(entry.loadEventEnd || 0)
            };
        }
    } catch {}

    return {
        href: location.href,
        title: doc.title || '',
        readyState: doc.readyState,
        visibility: doc.visibilityState,
        hasFocus: typeof doc.hasFocus === 'function' ? doc.hasFocus() : null,
        bodyChildren: doc.body ? doc.body.children.length : 0,
        bodyTextLen: doc.body ? (doc.body.innerText || doc.body.textContent || '').trim().length : 0,
        containers: containers.length,
        containerChildren: containers.reduce((sum, el) => sum + (el.children ? el.children.length : 0), 0),
        imageSelector,
        imgCount: allImgs.length,
        validImgCount: validImgs.length,
        dummyImgCount: srcs.filter(isDummySrc).length,
        completeImgCount: allImgs.filter(img => img.complete && img.naturalWidth > 0).length,
        lazyAttrCount: allImgs.filter(img => img.getAttribute('data-src') || img.getAttribute('data-lazy') || img.getAttribute('data-original')).length,
        firstImg: validImgs[0] || srcs[0] || '',
        novelFound: !!novelEl,
        novelTextLen: novelEl ? (novelEl.innerText || novelEl.textContent || '').trim().length : 0,
        ttsTextLen: ttsText.trim().length,
        cloudflare: cf,
        captcha,
        nav,
        ...extra
    };
}

function sendDiagnostics(queueId, phase, viewerCfg = {}, extra = {}) {
    try {
        sendToParent('WORKER_DIAGNOSTICS', {
            queueId,
            phase,
            diagnostics: collectPageDiagnostics(viewerCfg, extra)
        });
    } catch (e) {
        console.warn('[TokiSync:Worker] 진단 정보 전송 실패:', e.message);
    }
}

/**
 * Main execution of the Self-contained Worker
 */
export function initWorkerExtractor() {
    console.log("🚀 [TokiSync:Worker] 자립형 워커 엔진 시동 완료");

    // Establish Handshake Heartbeat every second until parent injects instructions
    let handshakeInterval = setInterval(() => {
        console.log("[TokiSync:Worker] 📢 READY 핸드셰이킹 하트비트 전송 중...");
        sendToParent('WORKER_READY', {
            targetUrl: window.location.href,
            timestamp: Date.now()
        });
    }, 1000);

    let isExtracting = false;

    // Register listener for commands from parent
    const cleanupIpc = registerIpcListener(async (msg) => {
        if (msg.type === 'START_EXTRACTION') {
            const { queueId } = msg.payload;

            try {
                if (typeof window.focus === 'function') {
                    window.focus();
                }
            } catch (e) {
                console.warn('[TokiSync:Worker] 팝업 포커스 신호 실패:', e.message);
            }

            sendDiagnostics(queueId, 'start-before-captcha');

            // CF Challenge Check
            const isCloudflare = document.title.includes('Just a moment') ||
                                 document.getElementById('cf-challenge-running') ||
                                 document.querySelector('.cf-browser-verification') ||
                                 document.getElementById('challenge-running');
            
            if (isCloudflare) {
                console.warn("⚠️ [TokiSync:Worker] 클라우드플레어 보안 챌린지 감지 - 대기 모드 진입");
                const diagnostics = collectPageDiagnostics({}, { detectedBy: 'cloudflare' });
                sendDiagnostics(queueId, 'captcha-detected', {}, { detectedBy: 'cloudflare' });
                sendToParent('CAPTCHA_DETECTED', { queueId, diagnostics });
                return;
            }

            if (isExtracting) return;
            isExtracting = true;

            // Stop Handshake Heartbeat
            if (handshakeInterval) {
                clearInterval(handshakeInterval);
                handshakeInterval = null;
            }

            const { 
                targetType, 
                seriesTitle, 
                rootFolder, // Normalized parent-side root folder name ([ID] Title)
                episodeTitle, 
                episodeNum, 
                folderId, 
                destination, 
                novelFormat, 
                matchedRule,
                protocolDomain,
                scanSpeedMultiplier = 1.0,
                localNameTemplate = "{number} - {title}",
                localEpisodePadding = "4",
                cover = '',
                meta = null
            } = msg.payload;

            console.log(`🚀 [TokiSync:Worker] 동작 지시문 수신 (ID: ${queueId}, 유형: ${targetType})`);
            reportProgress(queueId, 10, WORKER_STAGE.DOM_READY);

            // Reconstruct parser instance using injected matchedRule
            const parser = new GenericParser(protocolDomain || window.location.origin, matchedRule);
            const viewerCfg = parser.rule.viewer || {};
            sendDiagnostics(queueId, 'start', viewerCfg, { targetType });

            try {
                let blob = null;
                const configNovelFormat = novelFormat || 'epub';
                const extension = (targetType === 'novel') ? configNovelFormat : 'cbz';
                // NAS/저장 카테고리는 룰 원본(Webtoon/Manga/Novel)을 쓴다.
                //   targetType 은 novel/comic 2분류라 Webtoon↔Manga 구분이 사라지고,
                //   소문자라 Synology 에서 기존 대문자 폴더와 대소문자 충돌(UploadDBCaseConflict)을 유발한다.
                const storageCategory = (matchedRule && matchedRule.category) || (targetType === 'novel' ? 'Novel' : 'Webtoon');
                
                // Final Filename: Dynamic based on Template or Drive fallback
                let fullFilename;
                if (destination !== 'drive') {
                    const paddingVal = parseInt(localEpisodePadding, 10);
                    const paddedNum = paddingVal > 0 
                        ? (episodeNum || '').toString().padStart(paddingVal, '0') 
                        : (episodeNum || '').toString();

                    const template = localNameTemplate || "{number} - {title}";
                    fullFilename = template
                        .replace(/{number}/g, paddedNum)
                        .replace(/{rawNumber}/g, (episodeNum || '').toString())
                        .replace(/{series}/g, seriesTitle || rootFolder || '')
                        .replace(/{title}/g, episodeTitle || '');
                } else {
                    const paddedNum = (episodeNum || '').toString().padStart(4, '0');
                    fullFilename = `${paddedNum} - ${episodeTitle}`;
                }

                // --- 1. SOSEL EXTRACTION ---
                if (targetType === 'novel') {
                    reportProgress(queueId, 20, WORKER_STAGE.DOM_READY);
                    let content = "";

                    // --- Plan D (1순위): 페이지가 복호화해 노출한 평문 본문 (가장 안전) ---
                    //   sbxh(뉴토끼)는 /api/novel-content 복호화 결과를 TTS(음성읽기)용으로
                    //   window.__novelTTSText 와 'novel-content-ready' 이벤트(detail.text)에
                    //   평문으로 싣는다(문단 \n\n 보존). shadow/probe/복호화 일절 무관 →
                    //   안티-변조 footprint 0. (win-c 실측: 173문단 평문 확인, ntk_blk 없음)
                    //   워커는 회차 URL 을 window.open 으로 직접 여는 full-load 라 본문이 안정적으로 채워짐.
                    try {
                        const readTTS = () => (typeof window.__novelTTSText === 'string') ? window.__novelTTSText : '';
                        let ttsText = readTTS();
                        if (!ttsText || ttsText.trim().length < 100) {
                            // 아직 미충전 → 이벤트 + 폴링 병행(최대 ~6s)
                            ttsText = await new Promise((resolve) => {
                                let done = false;
                                const finish = (v) => { if (done) return; done = true; clearInterval(iv); window.removeEventListener('novel-content-ready', onReady); resolve(v || ''); };
                                const onReady = (e) => { const t = e?.detail?.text; if (typeof t === 'string' && t.trim().length >= 100) finish(t); };
                                window.addEventListener('novel-content-ready', onReady);
                                let n = 0;
                                const iv = setInterval(() => {
                                    const cur = readTTS();
                                    if (cur && cur.trim().length >= 100) finish(cur);
                                    else if (++n >= 12) finish('');
                                }, 500);
                            });
                        }
                        if (ttsText && ttsText.trim().length >= 100) {
                            content = ttsText.trim();
                            reportProgress(queueId, 50, WORKER_STAGE.PARSING);
                            console.log(`[TokiSync:Worker] ✅ Plan D(__novelTTSText) 본문 확보: ${content.length}자`);
                        } else {
                            sendDiagnostics(queueId, 'novel-tts-empty', viewerCfg);
                        }
                    } catch (e) {
                        console.warn('[TokiSync:Worker] Plan D 추출 예외(무시, 폴백 진행):', e.message);
                        sendDiagnostics(queueId, 'novel-tts-error', viewerCfg, { error: e.message });
                    }

                    // --- Plan B (2순위): 닫힌 shadow DOM 본문 (index.js 선택적 force-open 전제) ---
                    if (!content || content.trim().length < 100) {
                        let attempt = 0;
                        const maxAttempts = 10;
                        // Poll Shadow DOM for novel text
                        while (attempt < maxAttempts) {
                            attempt++;
                            console.log(`[TokiSync:Worker] 소설 Shadow DOM 폴링 중... (${attempt}/${maxAttempts})`);

                            const novelSel = viewerCfg.novelContent || '#novel_content';
                            const shadowHost = document.querySelector(novelSel)?.getRootNode()?.host
                                            || document.querySelector('.novel-epub-rendered')?.getRootNode()?.host
                                            || document.querySelector('.vw-bot-mini--novel')?.parentElement?.querySelector('div[style*="--novel-font-size"]');

                            if (shadowHost && shadowHost.shadowRoot) {
                                reportProgress(queueId, 50, WORKER_STAGE.PARSING);
                                const pTags = shadowHost.shadowRoot.querySelectorAll('.novel-epub-rendered p, p');
                                if (pTags.length > 0) {
                                    content = Array.from(pTags)
                                        .map(p => p.textContent.trim())
                                        .filter(text => text.length > 0)
                                        .join('\n\n');
                                } else {
                                    const bodyEl = shadowHost.shadowRoot.querySelector('.novel-epub-rendered');
                                    if (bodyEl) {
                                        content = bodyEl.innerText || bodyEl.textContent;
                                    } else {
                                        const tempDiv = document.createElement('div');
                                        tempDiv.innerHTML = shadowHost.shadowRoot.innerHTML;
                                        tempDiv.querySelectorAll('style, script').forEach(el => el.remove());
                                        content = tempDiv.innerText || tempDiv.textContent;
                                    }
                                }
                                break;
                            }
                            await sleep(500);
                        }
                        if (!content || content.trim().length < 100) {
                            sendDiagnostics(queueId, 'novel-shadow-empty', viewerCfg);
                        }
                    }

                    // --- Plan C (3순위): Decryption API ---
                    if ((!content || content.trim().length < 100) && viewerCfg.decryptApi) {
                        console.warn("[TokiSync:Worker] Plan D/B 실패 - Plan C API 복호화 폴백 구동");
                        content = await fetchNovelTextViaApi(window.location.href, viewerCfg.decryptApi);
                    }

                    if (!content || content.trim().length < 100) {
                        sendDiagnostics(queueId, 'novel-extraction-empty', viewerCfg);
                        throw new Error("소설 본문 추출에 실패했습니다. (Shadow DOM/API 복호화 무반응)");
                    }

                    reportProgress(queueId, 70, WORKER_STAGE.PARSING);
                    console.log(`[TokiSync:Worker] 소설 빌더 가동 시작 (${configNovelFormat.toUpperCase()})`);

                    const builder = (configNovelFormat === 'txt') ? new TxtBuilder() : new EpubBuilder();
                    builder.addChapter(episodeTitle, content.trim());

                    // [표지] 소설 EPUB: 시리즈 목록에서 동봉된 cover URL 을 받아 blob 화 → EpubBuilder 에 전달.
                    //   Kavita 는 파일명 "cover" 인 이미지를 표지로 사용(epub.js 에서 cover.<ext> 삽입).
                    let coverObj = null;
                    if (cover && configNovelFormat !== 'txt') {
                        try {
                            const cb = await fetchBlobWithXHR(cover);
                            if (cb && cb.size > 0) coverObj = { blob: cb, type: cb.type || 'image/jpeg' };
                        } catch (e) {
                            console.warn(`[TokiSync:Worker] 표지 다운로드 실패(무시): ${e.message}`);
                        }
                    }

                    const zip = await builder.build({
                        series: seriesTitle,
                        title: episodeTitle,
                        number: episodeNum,
                        writer: (meta && meta.author) || 'TokiSync',
                        author: (meta && meta.author) || '',
                        summary: (meta && meta.summary) || '',
                        status: (meta && meta.status) || '',
                        tags: (meta && meta.tags) || [],
                        cover: coverObj
                    });
                    blob = await zip.generateAsync({ type: 'blob' });

                } 
                // --- 2. MANHWA EXTRACTION ---
                else {
                    console.log("[TokiSync:Worker] 웹툰 콘텐츠 DOM 렌더링 대기 중...");
                    reportProgress(queueId, 20, WORKER_STAGE.DOM_READY);

                    // Wait for comic content inside DOM
                    const contentDoc = await waitForContent(window, Math.round(10000 * scanSpeedMultiplier), viewerCfg);
                    if (!contentDoc) {
                        console.warn("[TokiSync:Worker] 10초 내 콘텐츠 렌더링 미감지. 갈무리 강행.");
                        sendDiagnostics(queueId, 'comic-content-timeout', viewerCfg);
                    }

                    // 1.5s DOM Stabilization delay
                    reportProgress(queueId, 30, WORKER_STAGE.DOM_READY);
                    await sleep(1500);

                    console.log("[TokiSync:Worker] 스크롤 로드 및 이미지 다운로드 활성화");
                    reportProgress(queueId, 40, WORKER_STAGE.SCROLLING);

                    // Physical scroll down
                    await scrollToLoad(document, 25000, viewerCfg, scanSpeedMultiplier);

                    // Downloader helper with concurrency 5
                    const runImageDownloads = async (imageUrls) => {
                        const downloaded = [];
                        const CONCURRENCY_LIMIT = 5;
                        let processedCount = 0;

                        reportProgress(queueId, 0, WORKER_STAGE.DOWNLOADING);

                        for (let i = 0; i < imageUrls.length; i += CONCURRENCY_LIMIT) {
                            const chunk = imageUrls.slice(i, i + CONCURRENCY_LIMIT);
                            const chunkPromises = chunk.map(async (url, index) => {
                                const globalIndex = i + index;
                                try {
                                    const imgBlob = await fetchBlobWithXHR(url);
                                    const arrayBuffer = await blobToArrayBuffer(imgBlob);
                                    processedCount++;

                                    const percent = (processedCount / imageUrls.length) * 100;
                                    reportProgress(queueId, percent, WORKER_STAGE.DOWNLOADING);

                                    return {
                                        url,
                                        index: globalIndex,
                                        data: arrayBuffer,
                                        size: imgBlob.size,
                                        type: imgBlob.type
                                    };
                                } catch (err) {
                                    console.error(`[TokiSync:Worker] 이미지 다운로드 실패 (${url}):`, err);
                                    processedCount++;
                                    const percent = (processedCount / imageUrls.length) * 100;
                                    reportProgress(queueId, percent, WORKER_STAGE.DOWNLOADING);

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

                    // Execute initial fetch & download
                    let finalImages = parser.getImageList(document);
                    console.log(`🎯 [TokiSync:Worker] 1차 이미지 주소 ${finalImages.length}개 추출 완료.`);
                    sendDiagnostics(queueId, finalImages.length ? 'comic-image-list' : 'comic-image-list-empty', viewerCfg, {
                        finalImageCount: finalImages.length,
                        firstResolvedImage: finalImages[0] && finalImages[0].url ? finalImages[0].url : ''
                    });
                    let downloadedData = await runImageDownloads(finalImages.map(img => img.url));

                    // Deep Fallback: Trigger 15s retry if >50% placeholder dummy detected
                    const suspiciousCount = downloadedData.filter(d => !d.data || d.size < 30000).length;
                    if (suspiciousCount > finalImages.length / 2) {
                        console.warn(`⚠️ [Deep Fallback] 다수 더미 파일 감지 (${suspiciousCount}/${finalImages.length}) - 15초 정밀 재스크롤 시도`);
                        sendDiagnostics(queueId, 'comic-suspicious-dummy', viewerCfg, {
                            suspiciousCount,
                            finalImageCount: finalImages.length
                        });
                        reportProgress(queueId, 35, WORKER_STAGE.SCROLLING);
                        await sleep(2000);
                        
                        await scrollToLoad(document, 15000, viewerCfg, scanSpeedMultiplier);
                        
                        finalImages = parser.getImageList(document);
                        console.log(`🎯 [Deep Fallback] 2차 이미지 주소 ${finalImages.length}개 재추출 완료.`);
                        downloadedData = await runImageDownloads(finalImages.map(img => img.url));
                    }

                    // Placeholders Bypass Integration
                    const mergedData = downloadedData.map((downloadedItem, idx) => {
                        const originalInfo = finalImages[idx];
                        if ((!downloadedItem.data || downloadedItem.size < 100) && originalInfo && !originalInfo.isDummy) {
                            console.log(`[Worker] Dummy placeholder bypassed back to verified URL: ${downloadedItem.url}`);
                        }
                        return downloadedItem;
                    });

                    console.log(`🎯 [TokiSync:Worker] 이미지 조립 및 CBZ 빌딩 개시`);
                    reportProgress(queueId, 85, WORKER_STAGE.PARSING);

                    const builder = new CbzBuilder();
                    const resolvedImages = mergedData.map(img => {
                        const mimeType = img.type || 'image/jpeg';
                        return {
                            url: img.url,
                            blob: img.data ? new Blob([img.data], { type: mimeType }) : new Blob([]),
                            ext: img.type?.includes('png') ? '.png' : (img.type?.includes('webp') ? '.webp' : '.jpg'),
                            isMissing: !img.data
                        };
                    });

                    builder.addChapter(episodeTitle, resolvedImages);
                    // [메타] 만화 CBZ: 시리즈 목록에서 동봉된 meta(작가/소개/태그/상태) 를 ComicInfo 로 전달.
                    //   표지는 첫 이미지가 자동 사용되므로 별도 cover 불필요.
                    const zip = await builder.build({
                        series: seriesTitle,
                        title: episodeTitle,
                        number: episodeNum,
                        writer: (meta && meta.author) || 'TokiSync',
                        summary: (meta && meta.summary) || '',
                        status: (meta && meta.status) || '',
                        tags: (meta && meta.tags) || [],
                        category: storageCategory
                    });
                    blob = await zip.generateAsync({ type: 'blob' });
                }

                // --- 3. STORAGE PERSISTENCE (Direct Save/Upload) ---
                // 저장 대상 라벨 + 실제 경로 — 진행 라벨/완료 로그/IPC 에 동봉해 대시보드에서 실제 경로 표시.
                const _destLabel = (destination === 'native' || destination === 'webdav') ? 'NAS'
                                 : (destination === 'drive') ? '드라이브' : '로컬';
                const _savedPath = `${storageCategory}/${rootFolder || seriesTitle}/${fullFilename}.${extension}`;
                console.log(`[TokiSync:Worker] I/O 드라이버 기동 - 저장소 적재 시작 (${destination} → ${_savedPath})`);
                reportProgress(queueId, 90, WORKER_STAGE.UPLOADING, { destLabel: _destLabel, savedPath: _savedPath });

                await saveFile(blob, fullFilename, destination || 'drive', extension, {
                    folderName: rootFolder || seriesTitle,
                    category: storageCategory,
                    folderId: folderId || ''
                });

                console.log(`[TokiSync:Worker] 🎉 에피소드 수집 & 저장 완착 완료! (${_destLabel}: ${_savedPath})`);

                // Update final queue status inside Dexie/GM storage
                updateQueueItem(queueId, {
                    status: 'completed',
                    stage: WORKER_STAGE.COMPLETED,
                    progressPercent: 100
                });

                reportProgress(queueId, 100, WORKER_STAGE.COMPLETED, { destLabel: _destLabel, savedPath: _savedPath });

                // Notify parent that task succeeded
                sendToParent('TASK_COMPLETED', { queueId, destLabel: _destLabel, savedPath: _savedPath });
                cleanupIpc();

            } catch (err) {
                console.error(`[TokiSync:Worker] ❌ 에피소드 수집 중 치명적 오류 발생:`, err);
                
                updateQueueItem(queueId, { 
                    status: 'failed', 
                    stage: WORKER_STAGE.FAILED, 
                    errorMsg: err.message 
                });
                
                reportProgress(queueId, 0, WORKER_STAGE.FAILED);
                
                // Notify parent that task failed
                sendToParent('TASK_FAILED', { queueId, errorMsg: err.message });
                cleanupIpc();
            }
        }
    });
}
