import { sleep, waitIframeLoad, saveFile, getCommonPrefix, scrollToLoad, fetchBlobWithXHR } from './utils.js';
import { extractEpisodeData } from './extractor.js';
import { ParserFactory } from './parsers/ParserFactory.js';
import { detectSite } from './detector.js';
import { EpubBuilder } from './epub.js';
import { CbzBuilder } from './cbz.js';
import { TxtBuilder } from './txt.js';
import { LogBox, Notifier, tokiAlert, tokiConfirm } from './ui.js';
import { getConfig, isConfigValid, getCbzCompression, getConcurrency } from './config.js';
import { startSilentAudio, stopSilentAudio } from './anti_sleep.js';
import { fetchHistory, refreshCacheAfterUpload, getBooksByCacheId, initUpdateUploadViaGASRelay, getMergeIndexFragment } from './gas.js';
import { fetchHistoryDirect, checkSingleHistoryDirect, updateDirect } from './network.js';
import { fetchNovelText, fetchComicImages, closeActivePopup } from './novel-decryptor.js';

// Sleep Policy Presets
const SLEEP_POLICIES = {
    agile: { min: 1000, max: 3000 },      // 빠름 (1-3초)
    cautious: { min: 2000, max: 5000 },   // 신중 (2-5초)
    thorough: { min: 3000, max: 8000 },   // 철저 (3-8초)
    slow: { min: 5000, max: 15000 },      // 느림 (5-15초)
    very_slow: { min: 10000, max: 30000 } // 매우 느림 (10-30초)
};

export async function processItem(item, builder, siteInfo, iframe, parser, seriesTitle = "", targetDoc = null) {
    const { category } = siteInfo;
    const isNovel = (category === 'Novel' || category === 'novel');
    const viewerCfg = parser.rule.viewer || {};

    const logger = LogBox.getInstance();
    const config = getConfig();
    let policy = SLEEP_POLICIES[config.sleepMode] || SLEEP_POLICIES.agile;

    if (isNovel) {
        logger.log(`[소설] 추출 중: ${item.title}`, 'Downloader');

        const text = await fetchNovelText(item.src, {
            ...(viewerCfg.decryptApi || {}),
            viewerCfg: viewerCfg
        });

        if (text) {
            builder.addChapter(item.title, text);
            logger.log(`✅ 추출 성공: ${item.title}`, 'Downloader');
        } else {
            throw new Error(`추출 실패 (본문 응답 없음)`);
        }

        await sleep(policy.min, policy.max);
    } 
    else {
        logger.log(`[만화] 추출 중: ${item.title}`, 'Downloader');

        // 자식 팝업 내부에서 스크롤 로드 및 이미지 다운로드까지 전담하여 ArrayBuffer 패키지 회신
        const popupImages = await fetchComicImages(item.src, {
            viewerCfg: viewerCfg
        });

        if (popupImages && popupImages.length > 0) {
            // 부모 탭에서 ArrayBuffer 패키지를 Blob 배열로 환원 (MIME 형식 기반 확장자 유입)
            const resolvedImages = popupImages.map(img => {
                const getExtFromMime = (mime) => {
                    if (!mime) return '.jpg';
                    const lower = mime.toLowerCase();
                    if (lower.includes('png')) return '.png';
                    if (lower.includes('webp')) return '.webp';
                    if (lower.includes('gif')) return '.gif';
                    return '.jpg';
                };

                const mimeType = img.type || 'image/jpeg';
                const ext = getExtFromMime(mimeType);

                if (img.data) {
                    return {
                        url: img.url,
                        blob: new Blob([img.data], { type: mimeType }),
                        ext: ext,
                        isMissing: false
                    };
                } else {
                    return {
                        url: img.url,
                        blob: new Blob([]),
                        ext: ext,
                        isMissing: true
                    };
                }
            });

            // 제목 정제 규칙 적용
            let chapterTitleOnly = item.title;
            if (seriesTitle && chapterTitleOnly.startsWith(seriesTitle)) {
                chapterTitleOnly = chapterTitleOnly.replace(seriesTitle, '').trim();
            }

            const chapterMatch = chapterTitleOnly.match(/(\d+)화/);
            const chapterNum = chapterMatch ? chapterMatch[1].padStart(4, '0') : item.num;
            const cleanChapterTitle = `${chapterNum} ${chapterTitleOnly}`;

            builder.addChapter(cleanChapterTitle, resolvedImages);
            logger.log(`✅ 추출 및 다운로드 성공: ${item.title} (이미지 ${resolvedImages.length}개)`, 'Downloader');
        } else {
            throw new Error(`추출 실패 (이미지 팝업 패키지 획득 불가)`);
        }

        await sleep(policy.min, policy.max);
    }
}


/**
 * "1,2,4-10,15" 형식 문자열을 에피소드 번호 Set으로 변환
 * @param {string} spec - 범위 문자열. 빈 값이면 null 반환 (전체 의미)
 * @returns {Set<number>|null}
 */
export function parseRangeSpec(spec) {
    if (!spec || !spec.trim()) return null; // 빈 입력 = 전체
    const nums = new Set();
    const parts = spec.split(',');
    for (const part of parts) {
        const trimmed = part.trim();
        const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            const from = parseInt(rangeMatch[1]);
            const to   = parseInt(rangeMatch[2]);
            for (let n = Math.min(from, to); n <= Math.max(from, to); n++) nums.add(n);
        } else if (/^\d+$/.test(trimmed)) {
            nums.add(parseInt(trimmed));
        }
    }
    return nums.size > 0 ? nums : null;
}

export async function tokiDownload(rangeSpec, policy = 'zipOfCbzs', forceOverwrite = false) {
    const logger = LogBox.getInstance();
    logger.init();
    logger.show();
    logger.log(`다운로드 시작 (정책: ${policy}, 강제 덮어쓰기: ${forceOverwrite})...`);

    // Auto-start Anti-Sleep mode
    try {
        startSilentAudio();
        logger.success('[Anti-Sleep] 백그라운드 모드 자동 활성화');
    } catch (e) {
        logger.log('[Anti-Sleep] 자동 시작 실패 (사용자 상호작용 필요)', 'error');
    }

    const failedEpisodes = [];  // [v1.8.1] 완전 실패 리스트
    const partialFailures = []; // [v1.8.1] 부분 실패 리스트 (이미지 일부 누락)
    const siteInfo = await detectSite();
    if (!siteInfo) {
        tokiAlert("지원하지 않는 사이트이거나 다운로드 페이지가 아닙니다.");
        stopSilentAudio();
        return;
    }

    const parser = await ParserFactory.getParser();
    if (!parser) {
        tokiAlert("파서를 초기화할 수 없습니다.");
        stopSilentAudio();
        return;
    }

    const { category, matchedRule } = siteInfo;
    const siteName = matchedRule?.name || "TokiSync Parser";
    const isNovel = (category === 'Novel' || category === 'novel');

    try {
        // Prepare Strategy Variables
        let mainBuilder = null;
        let masterZip = null;
        let extension = 'zip';
        let destination = 'local'; // 기본 저장 대상
        let buildingPolicy = 'individual'; // 기본 빌딩 정책
        
        // [v1.6.0] 4대 정책 라우팅
        if (policy === 'individual') {
            buildingPolicy = 'individual';
            destination = 'local';
        } else if (policy === 'zipOfCbzs') {
            buildingPolicy = 'zipOfCbzs';
            destination = 'local';
        } else if (policy === 'native') {
            buildingPolicy = 'individual'; // 빌딩은 개별 CBZ 단위로 동일
            destination = 'native';        // 저장 대상만 GM_download로 변경
        } else if (policy === 'drive') {
            buildingPolicy = 'individual'; // 빌딩은 개별 CBZ 단위
            destination = 'drive';         // 저장 대상은 Google Drive
        // 하위 호환: 구버전 정책 명칭 지원
        } else if (policy === 'gasUpload') {
            buildingPolicy = 'individual';
            destination = 'drive';
            logger.log('⚠️ gasUpload 정책은 drive로 대체되었습니다.', 'warn');
        } else if (policy === 'folderInCbz') {
            buildingPolicy = 'zipOfCbzs';
            destination = 'local';
            logger.log('⚠️ folderInCbz 정책이 폐기되어 zipOfCbzs(배치)로 전환되었습니다.', 'warn');
        }

        // [v1.8.2] Graceful Fallback for missing Drive configuration
        if (destination === 'drive' && !isConfigValid()) {
            tokiAlert('구글 드라이브 설정(Folder ID 등)이 누락되었습니다. 임시로 개별 로컬 다운로드 정책으로 전환합니다.');
            logger.warn('⚠️ 구글 드라이브 설정 누락 감지. 정책을 개별 로컬 다운로드로 자동 전환합니다.', 'System');
            buildingPolicy = 'individual';
            destination = 'local';
        }

        const configNovelFormat = getConfig().novelFormat || 'epub';
        const EXTENSION_MAP = {
            'Novel': configNovelFormat,
            'novel': configNovelFormat,
            'Webtoon': 'cbz',
            'webtoon': 'cbz',
            'Manga': 'cbz',
            'manga': 'cbz'
        };

        if (buildingPolicy === 'zipOfCbzs') {
            masterZip = new JSZip(); // Master Container for current batch
            extension = EXTENSION_MAP[category] ?? 'cbz';
        } else {
            // Individual / native / drive
            extension = EXTENSION_MAP[category] ?? 'cbz';
        }

        // Get List
        let list = await parser.getListItems();

        // [v1.9.1] 정렬 로직 통합: 범위 필터 여부와 상관없이 항상 오름차순(1화~N화)으로 정렬
        const rangeSet = parseRangeSpec(rangeSpec);
        const mappedList = list.map(li => {
            const item = parser.parseListItem(li.element || li);
            return { li, num: parseInt(item.num) || 0 }; // 숫자가 아니면 0으로 처리하여 상단 배치
        });

        if (rangeSet) {
            list = mappedList.filter(item => rangeSet.has(item.num))
                             .sort((a, b) => a.num - b.num)
                             .map(item => item.li);
            logger.log(`범위 필터 적용 및 오름차순 정렬 완료: ${rangeSpec} → ${list.length}개 항목`);
        } else {
            list = mappedList.sort((a, b) => a.num - b.num)
                             .map(item => item.li);
            logger.log(`전체 항목 오름차순 정렬 완료: ${list.length}개 항목`);
        }
        
        // Log episode range
        if (list.length > 0) {
            const first = parser.parseListItem(list[list.length - 1]); // usually reversed order
            const last = parser.parseListItem(list[0]);
            logger.log(`총 ${list.length}개 항목 처리 예정. (${first.title} ~ ${last.title})`, 'Downloader');
        } else {
            logger.log(`총 0개 항목 처리 예정.`, 'Downloader');
        }

        if (list.length === 0) {
            logger.warn('에피소드 목록이 0개입니다. 사이트 구조가 달라졌거나 올바른 목록 페이지인지 확인하세요.', 'Downloader');
            tokiAlert("다운로드할 항목이 없습니다.");
            return;
        }

        // Folder Name (Title) & Common Title Extraction
        const first = parser.parseListItem(list[0]);
        const last = parser.parseListItem(list[list.length - 1]);
        
        // [v1.9.4] Extract Series ID via Parser rules with robust fallback
        const seriesId = parser.getSeriesId();

        // Determine Root Folder Name & Series Title
        const rootFolder = parser.getFormattedTitle(seriesId, first.title, last.title, getCommonPrefix);
        // Extract raw title from rootFolder (e.g., "[1234] Title" -> "Title")
        const seriesTitle = rootFolder.replace(/^\[[0-9]+\]\s*/, '');
        const listPrefixTitle = (list.length > 1) ? getCommonPrefix(first.title, last.title) : "";

        // [v1.7.0] Collect detailed metadata for Phase 3 Persistence
        const seriesMetadata = {
            ...parser.getSeriesMetadata(),
            title: seriesTitle || rootFolder,
            thumbnail: parser.getThumbnailUrl() || ""
        };

        // [Fix] Append Range [Start-End] for Local Merged Files (folderInCbz / zipOfCbzs)
        // GAS Upload uses individual files so no range needed in folder name
        // [v1.6.0 Update] Batch range is handled during saving, not in rootFolder variable
        if (buildingPolicy === 'zipOfCbzs') {
            const startNum = parseInt(first.num);
            const endNum = parseInt(last.num);
            // We'll append batch info later
        }

        // [v1.4.0] Upload Series Thumbnail (if uploading to Drive)
        if (destination === 'drive') {
            try {
                const thumbnailUrl = parser.getThumbnailUrl();
                if (thumbnailUrl) {
                    logger.log('📷 시리즈 썸네일 업로드 중...');
                    const thumbBlob = await fetchBlobWithXHR(thumbnailUrl);
                    
                    // Upload as 'cover.jpg' - network.js will auto-redirect to _Thumbnails/{ID}.jpg
                    // saveFile(data, filename, type, extension, metadata)
                    // → fullFileName = "cover.jpg"
                    await saveFile(thumbBlob, 'cover', 'drive', 'jpg', { 
                        category,
                        folderName: rootFolder  // Target folder for upload
                    });
                    logger.success('✅ 썸네일 업로드 완료');
                } else {
                    logger.log('⚠️  썸네일을 찾을 수 없습니다 (건너뜀)', 'warn');
                }
            } catch (thumbError) {
                logger.warn(`썸네일 업로드 실패 (계속 진행): ${thumbError.message}`, 'Downloader');
            }
        }

        // [v1.5.0 Smart Skip] Pre-load history for Drive uploads to skip already-uploaded episodes
        let uploadedHistorySet = new Set();
        // [v1.6.0 Fast Path] Pre-load episode cache
        let episodeCacheMap = new Map(); // key: "0001 - Title", value: "fileId"

        let historyCheckTimeoutFlag = false;
        let historyFolderId = null;

        if (destination === 'drive') {
            try {
                if (forceOverwrite) {
                    logger.log('⚠️ 강제 재다운로드 옵션 활성화: 기존 업로드 기록 무시 (전체 덮어쓰기)');
                } else {
                    logger.log('☁️ 드라이브 업로드 기록 및 용량 확인 중 (Smart Skip)...');
                    const histResult = await fetchHistoryDirect(rootFolder, category);
                    
                    if (histResult.success) {
                        // Normalize: accept padded ("0001") and plain ("1") forms
                        histResult.data.forEach(id => {
                            const plain = parseInt(id).toString();
                            uploadedHistorySet.add(id.toString());   // e.g. "0001"
                            uploadedHistorySet.add(plain);           // e.g. "1"
                        });
                        if (uploadedHistorySet.size > 0) {
                            logger.log(`⏭️ 조건 만족(기존 정상 업로드) 에피소드 ${histResult.data.length}개 감지 — 건너뜁니다.`);
                        }
                    } else {
                        historyCheckTimeoutFlag = true;
                        historyFolderId = histResult.folderId;
                        logger.log(`⚠️ 업로드 기록 조회 지연/타임아웃 감지. 개별 스킵(페일세이프) 모드로 전환합니다.`, 'warn');
                    }
                }
            } catch (histErr) {
                // Non-fatal: if history check fails unexpectedly
                logger.log(`⚠️ 업로드 기록 조회 실패: ${histErr.message}`, 'warn');
            }

            // [v1.6.0] Phase B-2: Load Master Index -> Cache File ID -> Episode List
            try {
                logger.log('⚡ 고속 업로드(Fast Path) 캐시 조회 중...');
                const config = getConfig();
                
                // 1. Fetch Complete Master Index
                const indexResponse = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "POST", url: config.gasUrl,
                        data: JSON.stringify({ type: "get_library", folderId: config.folderId, apiKey: config.apiKey, protocolVersion: 3 }),
                        headers: { "Content-Type": "text/plain" },
                        onload: (r) => {
                            try { resolve(JSON.parse(r.responseText)); } 
                            catch(e) { reject(e); }
                        },
                        onerror: reject
                    });
                });

                if (indexResponse.status === 'success') {
                    // 2. Find Current Series in Index by ID or Title
                    // [Fix] Handle both indexResponse.body (cached) and indexResponse.list (rebuild) structures
                    const seriesList = indexResponse.body || indexResponse.list || [];
                    
                    // Match by sourceId or title
                    const matchedSeries = seriesList.find(s => 
                        (s.sourceId && s.sourceId === seriesId) || 
                        (s.name && s.name.includes(seriesTitle))
                    );

                    let targetCacheFileId = matchedSeries ? matchedSeries.cacheFileId : null;
                    
                    if (targetCacheFileId) {
                        logger.log(`[Fast Path] 마스터 카탈로그에서 신규 캐시 파일 발견: ${targetCacheFileId}`);
                    } else {
                        // [v1.6.1] 2nd Attempt: Fetch Merge Index Fragment directly (Fallback for newly uploaded series)
                        logger.log(`[Fast Path] 마스터 카탈로그에 캐시 부재. _MergeIndex 대기열 파편을 탐색합니다...`);
                        const fragRes = await getMergeIndexFragment(seriesId);
                        if (fragRes.found && fragRes.data && fragRes.data.cacheFileId) {
                            targetCacheFileId = fragRes.data.cacheFileId;
                            logger.log(`[Fast Path] 큐에서 비동기 병합 파편 발견 성공! (ID: ${targetCacheFileId})`);
                        }
                    }

                    if (targetCacheFileId) {
                        // 3. Directly load episode cache using the cacheFileId
                        const cachedEpisodes = await getBooksByCacheId(targetCacheFileId);
                        
                        if (cachedEpisodes && cachedEpisodes.length > 0) {
                             cachedEpisodes.forEach(ep => {
                                 // Map "name" (e.g. "0001 - Title.cbz") to its Drive File ID
                                 // We strip the extension to match our `fullFilename` variable later
                                 const nameWithoutExt = ep.name.replace(/\.[^/.]+$/, "");
                                 episodeCacheMap.set(nameWithoutExt, ep.id);
                             });
                             logger.success(`[Fast Path] 맵핑 테이블 완성: ${episodeCacheMap.size}개 에피소드 캐시 로드 성공!`);
                        }
                    } else {
                        logger.log('[Fast Path] 신규 작품이거나 캐시 파편이 아직 없습니다 (일반 업로드 분기로 진행)');
                    }
                }
            } catch (cacheErr) {
                logger.log(`⚠️ 고속 업로드 캐시 로드 실패 (일반 분기로 진행방향 전환): ${cacheErr.message}`, 'warn');
            }
        }

        // Create IFrame
        // 목록 페이지 최하단에 배치 + opacity 0.1
        // IntersectionObserver가 정상 동작하며, 브라우저가 일반 문서 흐름으로 렌더링
        const iframe = document.createElement('iframe');
        iframe.classList.add('toki-visible-block', 'toki-downloader-iframe');
        document.body.appendChild(iframe);

        // [v1.7.1] Novel Single Volume Mode Init
        const configParams = getConfig();
        const novelMode = configParams.novelMode;
        const novelFormat = configParams.novelFormat || 'epub';
        const isSingleVolume = isNovel && novelMode === 'singleVolume';
        let masterNovelBuilder = null;
        if (isSingleVolume) {
            masterNovelBuilder = novelFormat === 'txt' ? new TxtBuilder() : new EpubBuilder();
            logger.log(`📙 소설 단행본 합본 모드 활성화 (${novelFormat.toUpperCase()}) (마지막에 한 번에 저장됩니다)`);
        }

        // --- Processing Loop ---
        // [custom] CFG_CONCURRENCY 옵션 — 사용자가 설정한 동시 처리 수.
        // 기본 1 = 순차. 2 이상 설정해도 현재는 안전을 위해 순차로 동작.
        // 본격 병렬화는 별도 PR에서 buildingPolicy/masterZip 배치/Fast Path 락 정리 후 도입 예정.
        const _concurrency = getConcurrency();
        if (_concurrency > 1) {
            logger.warn(
                `⚙️ 동시 처리 ${_concurrency} 설정됨 — 현재 버전은 안전을 위해 순차 처리로 동작합니다. ` +
                `(masterZip 배치/Fast Path 상호 배제 정리 후 다음 빌드에서 활성화 예정)`,
                'Downloader:Concurrency'
            );
        }
        for (let i = 0; i < list.length; i++) {
            const item = parser.parseListItem(list[i].element || list[i]); 
            console.clear();
            logger.log(`[${i + 1}/${list.length}] 처리 중: ${item.title}`);

            // [v1.5.0 Smart Skip] Skip already-uploaded episodes (Drive policy only)
            // [v1.7.1] Bypass skipping in Single Volume mode (we need all chapters)
            if (!isSingleVolume && destination === 'drive') {
                const numStr = item.num ? item.num.toString() : '';
                const numPlain = parseInt(numStr).toString();
                if (uploadedHistorySet.size > 0 && (uploadedHistorySet.has(numStr) || uploadedHistorySet.has(numPlain))) {
                    logger.log(`⏭️ 건너뜀 (이미 업로드됨): ${item.title}`);
                    continue;
                }
                
                // [v1.7.4] 페일세이프: 타임아웃 발생 시 개별 단위 핀셋 조회 수행
                if (historyCheckTimeoutFlag && historyFolderId) {
                    logger.log(`🔍 [페일세이프] 타임아웃 2차 단일 로컬/원격 검사 중: ${item.title}`);
                    const isUploaded = await checkSingleHistoryDirect(historyFolderId, numStr);
                    if (isUploaded) {
                        logger.log(`⏭️ [페일세이프 재검사] 건너뜀 (이미 업로드됨): ${item.title}`);
                        continue;
                    }
                }
            }

            // Decision based on Policy
            let currentBuilder = null;

            // [v1.6.0] Strategy: Always use a FRESH builder per item for Kavita compatibility
            // [v1.7.1] Except for Novel Single Volume Mode
            if (isSingleVolume) {
                currentBuilder = masterNovelBuilder;
            } else {
                if (isNovel) currentBuilder = novelFormat === 'txt' ? new TxtBuilder() : new EpubBuilder();
                else currentBuilder = new CbzBuilder();
            }

            // Process Item
            try {
                const result = await processItem(item, currentBuilder, siteInfo, iframe, parser, seriesTitle);
                
                // [v1.8.1] 부분 실패 체크 (이미지 누락 여부)
                if (currentBuilder && currentBuilder.chapters) {
                    const latestChapter = currentBuilder.chapters[currentBuilder.chapters.length - 1];
                    if (latestChapter && Array.isArray(latestChapter.images)) {
                        const missingCount = latestChapter.images.filter(img => img.isMissing).length;
                        if (missingCount > 0) {
                            console.warn(`[Downloader] 부분 실패 감지: ${item.title} (이미지 ${missingCount}개 누락)`);
                            partialFailures.push({
                                num: item.num,
                                title: item.title,
                                missingCount: missingCount
                            });
                        }
                    }
                }

                if (isSingleVolume) {
                    const currentSize = currentBuilder.chapters ? currentBuilder.chapters.length : (currentBuilder.content ? currentBuilder.content.split('===').length - 1 : 0);
                    logger.log(`📥 챕터 추가 완료: ${item.title} (현재 ${currentSize}개)`, 'Downloader');
                }
            } catch (err) {
                console.error(err);
                const errorMsg = err.message || "알 수 없는 오류";
                logger.error(`항목 처리 실패 (${item.title}): ${errorMsg}`, 'Downloader');
                
                // [v1.8.1] 실패 내역 저장
                failedEpisodes.push({
                    num: item.num,
                    title: item.title,
                    error: errorMsg
                });
                continue; // Skip faulty item but continue loop
            }

            // Post-Process for Non-Default Policies
            if (buildingPolicy !== 'folderInCbz' && !isSingleVolume) {
                // Build the individual chapter file
             
                // Clean Filename Logic
                // [v1.4.0 Update] Standardized format: "0001 - SeriesTitle 1화" (Keep Full Title)
                // Reason: Better identification when moving files out of folder
                
                let chapterTitle = item.title;
                
                // [v1.4.0] Title Normalization
                // If list title text differs from official metadata title, replace it.
                // Ex: List="Hot Manga 19", Meta="Cool Manga" -> "Cool Manga 19"
                // Condition: We have both titles, they differ, and item starts with list prefix
                if (seriesTitle && listPrefixTitle && seriesTitle !== listPrefixTitle && listPrefixTitle.length > 2) {
                     if (chapterTitle.startsWith(listPrefixTitle)) {
                         chapterTitle = chapterTitle.replace(listPrefixTitle, seriesTitle).trim();
                     }
                }
                
                // Only clean (remove series title) if uploading to Drive
                // [Deprecated] User requested to keep series title
                /*
                if (destination === 'drive' && seriesTitle && chapterTitle.startsWith(seriesTitle)) {
                    chapterTitle = chapterTitle.replace(seriesTitle, '').trim();
                }
                */

                // Final Filename: "0001 - Title"
                const fullFilename = `${item.num} - ${chapterTitle}`;

                // [v1.6.0] Kavita Metadata Insertion
                const innerZip = await currentBuilder.build({ 
                    series: seriesTitle || rootFolder,
                    title: chapterTitle,
                    number: item.num,
                    writer: siteName
                });
                const blob = await innerZip.generateAsync({ type: "blob", compression: getCbzCompression() });

                if (buildingPolicy === 'zipOfCbzs') {
                    console.log(`[MasterZip] 추가 중: ${fullFilename}.${extension}`);
                    masterZip.file(`${fullFilename}.${extension}`, blob);
                    
                    // [v1.8.2] Batching Logic
                    // Novel: Infinite batch. Webtoon: 20 per batch to prevent OOM
                    const processedCount = i + 1;
                    const isLastItem = (i === list.length - 1);
                    const BATCH_SIZE = isNovel ? Infinity : 20;

                    if ((BATCH_SIZE !== Infinity && processedCount % BATCH_SIZE === 0) || isLastItem) {
                        const batchNum = Math.ceil(processedCount / BATCH_SIZE);
                        const batchFilename = `${rootFolder}_Part${batchNum}`;
                        
                        logger.log(`📦 배치 저장 중... (${batchFilename})`);
                        await saveFile(masterZip, batchFilename, 'local', 'zip', { category });
                        
                        // Clear masterZip for next batch to save memory
                        masterZip = new JSZip();
                    }
                } else if (buildingPolicy === 'individual') {
                    // [v1.6.0] Phase B-3: Fast Path Smart Branching
                    let success = false;
                    const cachedFileId = episodeCacheMap.get(fullFilename);

                    if (destination === 'drive' && cachedFileId) {
                        try {
                            logger.log(`⚡ [Fast Path] 캐시 히트! Direct PATCH 진행 -> ID: ${cachedFileId} (${(blob.size/1024/1024).toFixed(1)}MB)`);

                            // [custom] Drive PATCH 직행 — GAS Relay + Base64 우회
                            // <=30MB single PATCH, >30MB resumable PATCH
                            try {
                                await updateDirect(cachedFileId, blob, `${fullFilename}.${extension}`);
                                logger.success(`⚡ [Fast Path] ${fullFilename} Direct PATCH 완료!`, 'FastPath');
                                success = true;
                            } catch (directErr) {
                                // Direct 실패 시 GAS Relay 폴백 (안전망)
                                logger.warn(`⚠️ [Fast Path] Direct PATCH 실패 (${directErr.message}) → GAS Relay 폴백`, 'FastPath');
                                const updateUrl = await initUpdateUploadViaGASRelay(cachedFileId, `${fullFilename}.${extension}`);
                                const CHUNK_SIZE = 20 * 1024 * 1024;
                                const totalSize = blob.size;
                                let start = 0;
                                const buffer = await blob.arrayBuffer();

                                while (start < totalSize) {
                                    const end = Math.min(start + CHUNK_SIZE, totalSize);
                                    const chunkBuffer = buffer.slice(start, end);
                                    const bytes = new Uint8Array(chunkBuffer);

                                    let binary = "";
                                    const chunk_size = 0x8000;
                                    for (let j = 0; j < bytes.length; j += chunk_size) {
                                        binary += String.fromCharCode.apply(null, bytes.subarray(j, j + chunk_size));
                                    }
                                    const chunkBase64 = window.btoa(binary);

                                    await new Promise((res, rej) => {
                                        GM_xmlhttpRequest({
                                            method: "POST", url: getConfig().gasUrl,
                                            data: JSON.stringify({
                                                type: "upload", uploadUrl: updateUrl, chunkData: chunkBase64,
                                                folderId: getConfig().folderId,
                                                protocolVersion: 3,
                                                start: start, end: end, total: totalSize, apiKey: getConfig().apiKey
                                            }),
                                            headers: { "Content-Type": "text/plain" },
                                            timeout: 300000,
                                            onload: (resp) => {
                                                try {
                                                    const json = JSON.parse(resp.responseText);
                                                    if (json.status === 'success') res(); else rej(new Error("Fail"));
                                                } catch (e) { rej(e); }
                                            },
                                            onerror: rej
                                        });
                                    });
                                    start = end;
                                }
                                logger.success(`⚡ [Fast Path] ${fullFilename} GAS Relay 폴백 완료`, 'FastPath');
                                success = true;
                            }
                        } catch (fastPathErr) {
                            const errMsg = fastPathErr.message || "";
                            logger.log(`⚠️ Fast Path 업로드 중 에러 발생 (${errMsg}), Fallback 시작...`, 'warn', 'FastPath');
                            
                            // [v1.7.3] 자가 회복 로직: 휴지통 또는 파일 부재 시 캐시 삭제
                            const lowerMsg = errMsg.toLowerCase();
                            if (lowerMsg.includes('trash') || lowerMsg.includes('not found')) {
                                logger.warn(`🗑️ [Fast Path] 휴지통/부재 감지 → 캐시에서 해당 항목 삭제 및 일반 업로드 전환: ${fullFilename}`);
                                episodeCacheMap.delete(fullFilename);
                            }
                            
                            success = false; // Fallback
                        }
                    }

                    if (!success) {
                        // Fallback (or local save)
                        logger.log(`[Upload] 일반 업로드(Create/POST) 진행...`);
                        await saveFile(blob, fullFilename, destination, extension, {
                            folderName: rootFolder,
                            category: category
                        });
                    }
                }
            }
            
            // [v1.4.0] Add completion badge to list item (real-time feedback)
            if (item.element && !item.element.querySelector('.toki-badge')) {
                const badge = document.createElement('span');
                badge.className = 'toki-badge';
                badge.innerText = '✅';
                // Styles moved to .toki-badge in ui.css
                
                // Target: .wr-subject > a (link element)
                const linkEl = item.element.querySelector('.wr-subject > a');
                if (linkEl) {
                    linkEl.prepend(badge);
                } else {
                    // Fallback
                    const titleEl = item.element.querySelector('.wr-subject, .item-subject, .title');
                    if (titleEl) {
                        titleEl.prepend(badge);
                    } else {
                        item.element.appendChild(badge);
                    }
                }
                
                // Visual feedback (v1.9.5 consistent styling)
                item.element.classList.add('toki-downloaded');
            }
        }


        // [v1.7.1] Finalize Single Volume EPUB/TXT
        if (isSingleVolume && masterNovelBuilder) {
            const hasContent = masterNovelBuilder.chapters ? masterNovelBuilder.chapters.length > 0 : masterNovelBuilder.content.length > 0;
            if (hasContent) {
                try {
                    // [v1.7.1 Update] Use Chapter Range for Filename instead of "(합본)"
                    // [v1.7.1 Update] Use Chapter Range for Filename instead of "(합본)" - Safe Parsing
                    const startRaw = last.num;
                    const endRaw = first.num;
                    const startNum = parseInt(startRaw);
                    const endNum = parseInt(endRaw);

                    let rangeLabel = "";
                    if (isNaN(startNum) || isNaN(endNum)) {
                        // Fallback to original labels if either is not numeric (e.g., "공지")
                        rangeLabel = (startRaw === endRaw) ? `${startRaw}` : `${startRaw}-${endRaw}`;
                    } else {
                        rangeLabel = (startNum === endNum) ? `${startNum}화` : `${Math.min(startNum, endNum)}-${Math.max(startNum, endNum)}화`;
                    }
                    const finalFilename = `${seriesTitle || rootFolder} (${rangeLabel})`;
                    
                    logger.log(`📚 단행본 조립 및 저장 중... (${finalFilename})`);
                    
                    const finalZip = await masterNovelBuilder.build({
                        series: seriesTitle || rootFolder,
                        title: seriesTitle || rootFolder,
                        writer: siteName
                    });
                    const finalBlob = await finalZip.generateAsync({ type: "blob", compression: getCbzCompression() });
                    
                    await saveFile(finalBlob, finalFilename, destination, extension, {
                        folderName: rootFolder,
                        category: category
                    });
                    
                    logger.success(`✅ 단행본 합본 저장 완료: ${finalFilename}`);
                } catch (epubErr) {
                    logger.error(`단행본 빌드 실패: ${epubErr.message}`);
                }
            } else {
                logger.warn('⚠️ 유효한 챕터가 없어 단행본 빌드를 취소합니다.', 'Downloader');
            }
        }

        // Cleanup
        iframe.remove();

        // Finalize Build (Batching logic already handles zipOfCbzs during loop)
        if (buildingPolicy === 'folderInCbz') {
            // Deprecated path, handled by zipOfCbzs transition
        }

        // [v1.5.5] 배치 완료 후 Drive 캐시 단일 갱신 (에피소드마다 호출하지 않음)
        if (destination === 'drive') {
            refreshCacheAfterUpload(rootFolder, category, seriesMetadata).catch(e =>
                logger.warn(`캐시 갱신 호출 중 실패 (무시): ${e.message}`, 'GAS:Cache')
            );
        }

        logger.success(`✅ 모든 작업 완료!`);
        Notifier.notify('TokiSync', `다운로드 완료! (${list.length - failedEpisodes.length}개 성공, ${failedEpisodes.length}개 실패)`);

        // [v1.8.1] 고도화된 실패 리포트 생성 및 저장 (MCP 검토 반영)
        await generateDownloadReport(seriesTitle || rootFolder, seriesId, list.length, failedEpisodes, partialFailures);

    } catch (error) {
        console.error(error);
        logger.error(`전체 다운로드 루틴 오류 발생: ${error.message}`, 'System');
        tokiAlert(`다운로드 중 오류 발생:\n${error.message}`);
    } finally {
        // Auto-stop Anti-Sleep mode
        stopSilentAudio();
        logger.log('[Anti-Sleep] 백그라운드 모드 자동 종료');
        
        // [Cleanup 팝업 세션] 다운로드 종료 후 액티브 팝업 폐쇄
        try {
            closeActivePopup();
        } catch (popupErr) {
            console.warn('[Downloader] 팝업 클린업 실패:', popupErr);
        }

        // Cleanup
        const iframe = document.querySelector('iframe');
        if (iframe) iframe.remove();
    }
}

async function fetchImages(imageUrls) {
    const logger = LogBox.getInstance();
    const promises = imageUrls.map(async (src) => {
        let retries = 3;
        let lastBlob = null;
        let lastExt = '.jpg';
        
        while (retries > 0) {
            try {
                const blob = await fetchBlobWithXHR(src);
                
                if (blob.size === 0) {
                    throw new Error("빈 이미지 데이터 (Blob size 0)");
                }

                // Metadata Extraction
                let ext = '.jpg';
                const extMatch = src.match(/\.[a-zA-Z]+$/);
                
                if (extMatch) {
                    ext = extMatch[0];
                } else {
                    // Fallback: Infer from Content-Type
                    const type = response.headers.get('content-type');
                    if (type) {
                        if (type.includes('png')) ext = '.png';
                        else if (type.includes('gif')) ext = '.gif';
                        else if (type.includes('webp')) ext = '.webp';
                        else if (type.includes('jpeg') || type.includes('jpg')) ext = '.jpg';
                    }
                }

                lastBlob = blob;
                lastExt = ext;

                // [v1.7.3] Hybrid Dummy Detection: Size + Resolution
                // 100KB 이하일 경우 Dummy일 확률이 있으나, 해상도가 높으면 정상으로 수용
                if (blob.size < 100 * 1024 && retries > 1) {
                    // 1. 확실한 더미 패턴 URL이면 재시도 없이 즉시 실패 처리
                    const isDummyUrl = (u) => u && (u.includes('blank.gif') || u.includes('loading.gif') || u.includes('pixel.gif'));
                    if (isDummyUrl(src)) {
                        retries = 1; 
                        throw new Error(`더미 이미지 URL 확인됨 (Skip retry)`);
                    }

                    // 2. 해상도 체크 (가로 또는 세로가 300px 이상이면 정상 이미지로 간주)
                    const { getImageDimensions } = await import('./utils.js');
                    const { width, height } = await getImageDimensions(blob);
                    
                    if (width > 300 || height > 300) {
                        // 규격이 정상인 경우 용량에 상관없이 수용
                        return { src, blob, ext };
                    }

                    throw new Error(`저용량 및 저해상도 의심 (${(blob.size/1024).toFixed(1)}KB, ${width}x${height}) - Lazy 더미 이미지일 수 있으므로 재시도`);
                }

                return { src, blob, ext };
            } catch (e) {
                retries--;
                const retryCount = 3 - retries;
                if (retries > 0) logger.warn(`이미지 다운로드 재시도 (${retryCount}/3): ${e.message}`, 'Network:Image');
                
                if (retries === 0) {
                    // 3회 모두 실패했고 lastBlob이 존재하지만, 여전히 dummy 성격이면 거절
                    if (lastBlob && lastBlob.size > 10000) { // 10KB 이상일 때만 보수적 수용
                        logger.log(`⚠️ 용량이 작지만 수용 (${(lastBlob.size/1024).toFixed(1)}KB): ${src.split('/').pop()}`, 'Network:Image');
                        return { src, blob: lastBlob, ext: lastExt };
                    }
                    
                    console.error(`이미지 다운로드 최종 실패 (${src}):`, e);
                    logger.error(`⚠️ 이미지 누락: ${src.split('/').pop()} (3회 재시도 실패)`, 'Network:Image');
                    
                    // [Fix] 다운로드 실패 시 null 반환 대신 안내 페이지 삽입
                    const placeholderText = `[PAGE_MISSING]\n\n해당 웹툰 페이지를 다운로드할 수 없었습니다.\n원인: 서버 제한 또는 백그라운드 스로틀링 (Lazy Load 실패)\n\nURL: ${src}`;
                    const placeholderBlob = new Blob([placeholderText], { type: 'text/plain' });
                    
                    return { src, blob: placeholderBlob, ext: '.txt', isMissing: true };
                }
                
                // 재시도 대기 (v1.7.2: 1.5초 -> 0.5초)
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
    });

    return await Promise.all(promises);
}

/**
 * [v1.8.1] 다운로드 실패 리포트 생성 및 다운로드 (MCP 검토 의견 반영)
 * @private
 */
async function generateDownloadReport(seriesTitle, seriesId, listCount, failedEpisodes, partialFailures) {
    const logger = LogBox.getInstance();
    if (failedEpisodes.length === 0 && partialFailures.length === 0) return;

    logger.warn(`⚠️ 다운로드 중 일부 오류가 발견되었습니다. 리포트를 생성합니다.`, 'System');

    const timestamp = new Date().toLocaleString();
    const lines = [
        `[TokiSync 다운로드 리포트]`,
        `작품명: ${seriesTitle}`,
        `일시: ${timestamp}`,
        `--------------------------------------------------`,
        `■ 요약 (Summary)`,
        `- 총 시도: ${listCount}개`,
        `- 성공: ${listCount - failedEpisodes.length}개`,
        `- 완전 실패: ${failedEpisodes.length}개 (파일이 생성되지 않음)`,
        `- 부분 실패: ${partialFailures.length}개 (파일은 생성되었으나 일부 데이터 누락)`,
        `--------------------------------------------------`,
    ];

    if (failedEpisodes.length > 0) {
        lines.push(``, `■ 완전 실패 목록 (Critical Failures)`, `(원인 분석 후 해당 회차만 재시도해 보세요)`);
        failedEpisodes.forEach(fail => {
            lines.push(`- [${fail.num}] ${fail.title} : ${fail.error}`);
        });
    }

    if (partialFailures.length > 0) {
        lines.push(``, `■ 부분 실패 목록 (Warnings/Partial Success)`, `(다운로드는 완료되었으나 일부 페이지가 누락된 항목입니다)`);
        partialFailures.forEach(fail => {
            lines.push(`- [${fail.num}] ${fail.title} : 이미지 ${fail.missingCount}개 누락`);
        });
    }

    lines.push(``, `--------------------------------------------------`, `위 리포트를 참고하여 누락된 회차를 확인하시기 바랍니다.`);

    const reportContent = lines.join('\n');
    const reportBlob = new Blob([reportContent], { type: 'text/plain;charset=utf-8' });
    const cleanSeriesTitle = (seriesTitle || "Unknown").replace(/[<>:"/\\|?*]/g, '').trim();
    const reportFilename = `${cleanSeriesTitle}_다운로드_실패_리포트`;

    try {
        await saveFile(reportBlob, reportFilename, 'local', 'txt');
        logger.success(`✅ 실패 리포트 다운로드 완료: ${reportFilename}.txt`);
    } catch (e) {
        console.error('[Downloader] 리포트 저장 실패:', e);
    }
}
