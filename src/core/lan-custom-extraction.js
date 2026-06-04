export const MIN_LAN_COMIC_IMAGE_COUNT = 3;

function queryAllSafe(doc, selector) {
    try { return selector ? Array.from(doc.querySelectorAll(selector)) : []; }
    catch { return []; }
}

export function collectLanPageDiagnostics(viewerCfg = {}, extra = {}) {
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

export function sendLanDiagnostics(sendToParent, queueId, phase, viewerCfg = {}, extra = {}) {
    try {
        sendToParent('WORKER_DIAGNOSTICS', {
            queueId,
            phase,
            diagnostics: collectLanPageDiagnostics(viewerCfg, extra)
        });
    } catch (e) {
        console.warn('[TokiSync:Worker] 진단 정보 전송 실패:', e.message);
    }
}

export function getLanStorageCategory(matchedRule, targetType) {
    return (matchedRule && matchedRule.category) || (targetType === 'novel' ? 'Novel' : 'Webtoon');
}

export async function buildLanCoverObject(cover, novelFormat, fetchBlobWithXHR, referer) {
    if (!cover || novelFormat === 'txt') return null;
    try {
        const coverBlob = await fetchBlobWithXHR(cover, referer);
        if (coverBlob && coverBlob.size > 0) {
            return { blob: coverBlob, type: coverBlob.type || 'image/jpeg' };
        }
    } catch (e) {
        console.warn(`[TokiSync:Worker] 표지 다운로드 실패(무시): ${e.message}`);
    }
    return null;
}

export function getLanNovelBuildMetadata(meta, coverObj) {
    return {
        writer: (meta && meta.author) || 'TokiSync',
        author: (meta && meta.author) || '',
        summary: (meta && meta.summary) || '',
        status: (meta && meta.status) || '',
        tags: (meta && meta.tags) || [],
        cover: coverObj
    };
}

export function getLanComicBuildMetadata(meta, storageCategory) {
    return {
        writer: (meta && meta.author) || 'TokiSync',
        summary: (meta && meta.summary) || '',
        status: (meta && meta.status) || '',
        tags: (meta && meta.tags) || [],
        category: storageCategory
    };
}

export function getLanSaveTarget({ destination, storageCategory, rootFolder, seriesTitle, fullFilename, extension }) {
    const destLabel = (destination === 'native' || destination === 'webdav') ? 'NAS'
        : (destination === 'drive') ? '드라이브' : '로컬';
    const savedPath = `${storageCategory}/${rootFolder || seriesTitle}/${fullFilename}.${extension}`;
    return {
        destLabel,
        savedPath,
        metadata: {
            folderName: rootFolder || seriesTitle,
            category: storageCategory
        }
    };
}
