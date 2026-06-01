import { tokiDownload, processItem } from './downloader.js';
import { detectSite, getMaxEpisodes, parseEpisodeRange } from './detector.js'; 
import { showConfigModal, getConfig, setConfig, isConfigValid, CFG_GLOBAL_URL_EXCLUDE, getGlobalUrlExcludeList, CFG_CBZ_COMPRESSION, CFG_CONCURRENCY, getCbzCompression, getConcurrency } from './config.js';
import { LogBox, markDownloadedItems, MenuModal, TreeRuleEditor, showRuleDebugModal, tokiAlert, tokiConfirm, tokiPrompt } from './ui.js';
import { extractEpisodeData } from './extractor.js';
import { EpubBuilder } from './epub.js';
import { CbzBuilder } from './cbz.js';
import { TxtBuilder } from './txt.js';
import { fetchHistory } from './gas.js';
import { ParserFactory } from './parsers/ParserFactory.js';
import { getOAuthToken, fetchHistoryDirect } from './network.js';

import { getCommonPrefix, blobToArrayBuffer, saveFile, fetchBlobWithXHR } from './utils.js';
import { registerQueueMenu, maybeRunQueue } from './queue.js';
import { registerRemoteMenu, startRemoteSync } from './remote.js';

/** 정책 → 저장 대상(destination) 매핑 (downloader.js 규칙과 동일). */
function policyToDestination(policy) {
    if (policy === 'native') return 'native';
    if (policy === 'drive' || policy === 'gasUpload') return 'drive';
    return 'local'; // individual / zipOfCbzs / folderInCbz
}

/**
 * 현재 페이지(회차 1개)만 다운로드. destination 으로 저장 대상 지정(기본 'local').
 *   멀티-IP(lease) 모드에서 회차 unit 을 받을 때, 전체 시리즈(tokiDownload)가 아니라
 *   "현재 회차만" 이 함수로 받는다(회차 페이지엔 목록이 없어 tokiDownload 는 0개 처리됨).
 */
async function downloadSingleEpisode(destination = 'local', unit = null) {
    const logger = LogBox.getInstance();
    logger.show();
    logger.log('🚀 현재 회차 다운로드 시작...', 'System');

    // [멀티-IP lease 분기] unit.unitId 가 있으면 부모 탭은 회차 페이지로 이동하지 않는다(시리즈 목록 등에 고정).
    //   부모의 `document` 는 회차 페이지가 아니므로 extractEpisodeData(document,...) 로 메타 재추출 금지(엉뚱한 페이지).
    //   회차 메타는 시리즈 목록의 권위값(unit.series/num/title)을 그대로 쓰고, 본문은 워커 팝업이 unit.url 로 가서 수집.
    //   회차 URL 도 부모의 document.URL 이 아니라 반드시 unit.url 을 사용한다(부모는 회차에 안 가므로).
    const isLease = !!(unit && unit.unitId);

    // 사이트 룰/파서 — lease 모드는 부모 페이지가 아니라 unit.url(회차) 기준으로 판정한다.
    //   ⚠️ 부모가 만화 페이지에 고정된 채 소설 unit 을 처리하면 category=Manga 로 잡혀 소설을 이미지
    //   추출(fetchComicImages)로 오처리 → "이미지 팝업 패키지 획득 불가" 실패 + 명명 깨짐.
    //   unit.url 룰로 소설/만화를 정확히 분기(getParserForUrl 은 현재 location 무관).
    let siteInfo = null, parser = null;
    if (isLease && unit.url) {
        parser = await ParserFactory.getParserForUrl(unit.url);
        if (parser && parser.rule) {
            let origin = ''; try { origin = new URL(unit.url).origin; } catch (e) {}
            siteInfo = { site: 'generic', protocolDomain: origin, matchedRule: parser.rule, category: parser.rule.category || 'Webtoon' };
        }
    }
    if (!siteInfo) siteInfo = await detectSite();
    if (!parser) parser = await ParserFactory.getParser();
    if (!parser) throw new Error('파서를 찾을 수 없습니다.');

    const metadata = isLease ? {} : await extractEpisodeData(document, parser, siteInfo, false);
    const seriesTitle = metadata.seriesTitle || (isLease ? (unit.series || 'Unknown_Series') : 'Unknown_Series');
    // 시리즈 메타(작가/요약/태그/상태)는 파서가 제공할 때만 신뢰. lease 시 부모가 목록 페이지에 있어도
    //   특정 작품을 가리키지 않을 수 있어 best-effort. 없으면 빈 메타(파일명/폴더명엔 영향 없음).
    const seriesMeta = (typeof parser.getSeriesMetadata === 'function') ? (parser.getSeriesMetadata() || {}) : {};
    // 폴더명은 expand(메인 페이지)에서 계산한 정식값([id] 작품명)을 우선 — 회차마다/외전까지 일관.
    //   회차 페이지에선 작품명 추출이 불안정하므로(외전 등) 이게 핵심.
    const folderName = (unit && unit.series) || seriesTitle;

    // 회차 번호/제목도 시리즈 목록의 권위값(unit.num/unit.title) 우선 — 외전·소수회차(327.5)도 정확.
    let num = (unit && unit.num) ? String(unit.num) : (metadata.episodeNum || '0000');
    if (/^\d+$/.test(num)) num = num.padStart(4, '0'); // "332"→"0332" (소수 327.5 등은 그대로)
    let epTitle = (unit && unit.title) ? unit.title : (metadata.episodeTitle || 'Current_Episode');
    // 폴더에 이미 들어간 작품명 접두사를 제목에서 제거(중복 방지). "[14] 일곱개의 대죄" → "일곱개의 대죄".
    const workName = String(folderName).replace(/^\[[^\]]*\]\s*/, '').trim();
    if (workName && epTitle.startsWith(workName)) {
        epTitle = epTitle.slice(workName.length).replace(/^[\s\-:·~|]+/, '').trim() || epTitle;
    }

    const isNovel = (siteInfo.category === 'Novel' || siteInfo.category === 'novel');
    let builder;
    let extension = 'cbz';
    if (isNovel) {
        const novelFormat = getConfig().novelFormat || 'epub';
        builder = novelFormat === 'txt' ? new TxtBuilder() : new EpubBuilder();
        extension = novelFormat;
    } else {
        builder = new CbzBuilder(epTitle);
    }

    // lease 모드: 본문 수집 대상 URL 은 부모의 현재 페이지가 아니라 unit.url(회차 페이지). 워커 팝업이 이 URL 로 이동해 수집한다.
    //   단일/벌크 모드: 기존대로 부모가 머문 회차 페이지(document.URL)를 사용.
    const episodeUrl = isLease ? unit.url : document.URL;
    const tempItem = { title: epTitle, src: episodeUrl, url: episodeUrl, num };
    await processItem(tempItem, builder, siteInfo, null, parser, seriesTitle, document);

    // [표지] 소설 EPUB 에 Kavita 표지용 cover.<ext> 삽입.
    //   lease 모드: expand 시 동봉한 unit.cover URL / 단일 모드: 라이브 파서 getThumbnailUrl().
    //   @connect * 라 CDN(i.toonflix.app 등)도 fetchBlobWithXHR(GM_xmlhttpRequest)로 수신 가능.
    let coverData = null;
    if (isNovel && extension === 'epub') {
        let coverUrl = (isLease && unit && unit.cover) ? unit.cover : '';
        if (!coverUrl && typeof parser.getThumbnailUrl === 'function') {
            try { coverUrl = parser.getThumbnailUrl() || ''; } catch (e) {}
        }
        if (coverUrl) {
            try {
                const b = await fetchBlobWithXHR(coverUrl);
                if (b && b.size) coverData = { blob: b, type: b.type || 'image/jpeg' };
            } catch (e) { logger.warn(`표지 다운로드 실패(건너뜀): ${e && e.message}`, 'Cover'); }
        }
    }

    logger.log('💾 파일 생성 및 저장 중...', 'System');
    const zip = await builder.build({
        series: workName || seriesTitle, title: epTitle, number: num,
        writer: seriesMeta.author || '', author: seriesMeta.author || '',
        summary: seriesMeta.summary || '', status: seriesMeta.status || '',
        tags: seriesMeta.tags || [], category: siteInfo.category,
        cover: coverData,
    });
    const blob = await zip.generateAsync({ type: 'blob', compression: getCbzCompression() });
    const filename = `${num} - ${epTitle}`;
    await saveFile(blob, filename, destination, extension, { category: siteInfo.category, folderName });
    logger.success(`✅ 회차 다운로드 완료! (${folderName}/${filename})`, 'System');
    return { num, title: epTitle };
}

export async function main() {
    console.log("🚀 TokiDownloader Loaded (New Core v1.20.5)");
    
    const logger = LogBox.getInstance();

    // [DIAG] 이등분 레벨: 3=히스토리/원격 동기화 포함, 4=UI(FAB) 포함
    const __TD = (function () { try { var v = localStorage.getItem('__toki_diag'); return v == null ? 99 : (parseInt(v, 10) || 0); } catch (e) { return 99; } })();

    // -- 0. Core Logic starts after helper function definitions --

    // -- Helper Functions for Menu Actions --

    const openViewer = () => {
         const config = getConfig();
         const viewerUrl = "https://pray4skylark.github.io/tokiSync/";
         const win = window.open(viewerUrl, "_blank");
         
         if(win) {
             let attempts = 0;
             const interval = setInterval(() => {
                 attempts++;
                 win.postMessage({ type: 'TOKI_CONFIG', config: config }, '*');
                 if(attempts > 10) clearInterval(interval);
             }, 500);
         } else {
             tokiAlert("팝업 차단을 해제해주세요.");
         }
    };

    const runThumbnailMigration = async () => {
        if(!(await tokiConfirm("이 작업은 기존 다운로드된 작품들의 썸네일을 새로운 최적화 폴더(_Thumbnails)로 이동시킵니다.\n실행하시겠습니까? (서버 부하가 발생할 수 있습니다)"))) return;
        
        const config = getConfig();
        const win = window.open("", "MigrationLog", "width=600,height=800");
        win.document.write("<h3>🚀 v1.4.0 Migration Started...</h3><pre id='log'></pre>");
        
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: config.gasUrl,
                data: JSON.stringify({
                    type: 'view_migrate_thumbnails',
                    folderId: config.folderId,
                    apiKey: config.apiKey,
                    protocolVersion: 3
                }),
                onload: (res) => {
                    try {
                        const result = JSON.parse(res.responseText);
                        if(result.status === 'success') {
                            const logs = result.body.join('\n');
                            win.document.getElementById('log').innerText = logs;
                            tokiAlert("✅ 마이그레이션이 완료되었습니다!");
                        } else {
                            win.document.getElementById('log').innerText = "Failed: " + result.body;
                            tokiAlert("❌ 오류 발생: " + result.body);
                        }
                    } catch (e) {
                        win.document.getElementById('log').innerText = res.responseText;
                        tokiAlert("❌ GAS 서버 오류");
                    }
                },
                onerror: (err) => {
                     win.document.getElementById('log').innerText = "Network Error";
                     tokiAlert("❌ 네트워크 오류");
                }
            });
        } catch(e) {
            tokiAlert("오류: " + e.message);
        }
    };

    const runFilenameMigration = async () => {
        if (!(await tokiConfirm('현재 작품의 파일명을 표준화하시겠습니까?\n(예: "0001 - 1화.cbz" -> "0001 - 제목 1화.cbz")'))) return;
        
        const parserInfo = await ParserFactory.getParser();
        if (!parserInfo) {
            tokiAlert('현재 사이트를 지원하는 파서를 찾을 수 없습니다.');
            return;
        }
        
        const seriesId = parserInfo.parser.getSeriesId();

        if (!seriesId || seriesId === "0000") {
            tokiAlert('시리즈 ID를 찾을 수 없습니다.');
            return;
        }

        try {
            logger.show();
            logger.log('이름 변경 작업 요청 중...');
            
            const token = await getOAuthToken(); // FIXME: OAuth or API Key? Config uses API Key usually.
            const config = getConfig();
            
            if (!config.gasUrl) {
                tokiAlert('GAS URL이 설정되지 않았습니다.');
                return;
            }

            GM_xmlhttpRequest({
                method: "POST",
                url: config.gasUrl,
                data: JSON.stringify({
                    type: 'view_migrate_filenames',
                    seriesId: seriesId,
                    folderId: config.folderId,
                    apiKey: config.apiKey,
                    protocolVersion: 3
                }),
                headers: {
                    // "Authorization": `Bearer ${token}`, // If using OAuth
                    "Content-Type": "application/json"
                },
                onload: (res) => {
                    try {
                        const result = JSON.parse(res.responseText);
                        if (result.status === 'success') {
                            const logs = Array.isArray(result.body) ? result.body.join('\n') : result.body;
                            logger.success(`작업 완료!\n로그:\n${logs}`);
                            tokiAlert(`작업이 완료되었습니다.`);
                        } else {
                            logger.error(`작업 실패: ${result.body}`);
                            tokiAlert(`실패: ${result.body}`);
                        }
                    } catch (parseErr) {
                        logger.error(`응답 파싱 실패: ${parseErr.message}`);
                    }
                },
                onerror: (err) => {
                    logger.error(`네트워크 오류: ${err.statusText}`);
                    tokiAlert('네트워크 오류 발생');
                }
            });
        } catch (e) {
            tokiAlert('오류 발생: ' + e.message);
            console.error(e);
        }
    };

    // -- 1. GM Menus (Must be registered early to prevent deadlocks) --
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('⚙️ 설정 (Settings)', () => showConfigModal());
        GM_registerMenuCommand('🧩 파싱 규칙 관리', () => {
            const editor = new TreeRuleEditor();
            editor.show();
        });
        GM_registerMenuCommand('📜 로그창 토글 (Log)', () => logger.toggle());
        GM_registerMenuCommand('🌐 Viewer 열기', openViewer);
        GM_registerMenuCommand('📥 전체 다운로드', () => {
            const config = getConfig();
            tokiDownload(undefined, config.policy);
        });
        GM_registerMenuCommand('📂 파일명 표준화 (Migration)', runFilenameMigration);
        GM_registerMenuCommand('🔍 룰 디버그 (현재 페이지)', () => showRuleDebugModal());
        GM_registerMenuCommand(`📦 CBZ 압축 모드 (현재: ${getCbzCompression()})`, async () => {
            const cur = getCbzCompression();
            const next = cur === 'STORE' ? 'DEFLATE' : 'STORE';
            const ok = await tokiConfirm(
                `CBZ 압축 모드를 ${cur} → ${next} 로 변경합니다.\n\n` +
                `• DEFLATE: 파일 작음, 느림 (기본)\n` +
                `• STORE:   파일 큼, ZIP 빌드 30~50% 빠름\n\n` +
                `계속하시겠습니까?`
            );
            if (ok && typeof GM_setValue !== 'undefined') {
                GM_setValue(CFG_CBZ_COMPRESSION, next);
                await tokiAlert(`✅ CBZ 압축 모드: ${next}\n페이지 새로고침 후 적용됩니다.`);
            }
        });
        GM_registerMenuCommand(`⚡ 회차 동시 처리 수 (현재: ${getConcurrency()})`, async () => {
            const cur = getConcurrency();
            const input = await tokiPrompt(
                `한 번에 동시 처리할 회차 수를 입력하세요.\n` +
                `1 = 순차 (기본, 가장 안전)\n` +
                `2~3 = 적당한 가속 (사이트 부하 주의)\n` +
                `4~8 = 공격적 (차단 위험)`,
                String(cur)
            );
            if (input === null) return;
            const n = parseInt(input, 10);
            if (!Number.isFinite(n) || n < 1 || n > 8) {
                await tokiAlert('1~8 사이 정수를 입력하세요.');
                return;
            }
            if (typeof GM_setValue !== 'undefined') {
                GM_setValue(CFG_CONCURRENCY, String(n));
                await tokiAlert(`✅ 회차 동시 처리 수: ${n}\n페이지 새로고침 후 적용됩니다.`);
            }
        });
        GM_registerMenuCommand('🚫 전역 URL 차단 패턴 편집', async () => {
            const cur = (typeof GM_getValue !== 'undefined') ? GM_getValue(CFG_GLOBAL_URL_EXCLUDE, '') : '';
            const next = await tokiPrompt(
                '모든 룰에 자동 적용될 URL 차단 패턴 (쉼표 또는 줄바꿈 구분).\n' +
                '예: /board_uploads/, /ads/, i.toonflix.app/board\n\n' +
                '/regex/ 형식도 지원합니다.',
                cur,
                { multiline: true }
            );
            if (next !== null && typeof GM_setValue !== 'undefined') {
                GM_setValue(CFG_GLOBAL_URL_EXCLUDE, next);
                const list = next.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
                await tokiAlert(`✅ 전역 URL 차단 패턴 ${list.length}개 저장됨:\n` + list.join('\n') + '\n\n페이지 새로고침 후 적용됩니다.');
            }
        });
    }

    // -- 2. Pre-detection & Core States --
    const siteInfo = await detectSite();
    if(!siteInfo) {
        console.warn('[TokiSync] 사이트 매칭 실패. 탬퍼몽키 메뉴를 통해 설정을 확인하세요.');
        return; 
    }

    // -- History Sync (Async) & Cross-Tab Auto Refresh --
    let lastSyncTime = Date.now();
    let isSyncing = false;

    const syncHistory = async () => {
        if (isSyncing) return;
        isSyncing = true;
        try {
            const parser = await ParserFactory.getParser();
            if (!parser) return;
            const list = await parser.getListItems();
            console.log(`[TokiSync] Found ${list.length} list items`);
            if (list.length === 0) {
                console.warn('[TokiSync] No list items found, skipping history sync');
                return;
            }

            const first = parser.parseListItem(list[0]);
            const last = parser.parseListItem(list[list.length - 1]);

            const seriesId = parser.getSeriesId();

            // Determine Root Folder Name (Unified with Downloader)
            const rootFolder = parser.getFormattedTitle(seriesId, first.title, last.title, getCommonPrefix);

            const category = siteInfo.category || 'Webtoon';

            if (!isConfigValid()) {
                console.log('[TokiSync] GAS 설정을 찾을 수 없어 이력 동기화를 건너뜁니다.');
                return;
            }

            console.log(`[TokiSync] Fetching history for: ${rootFolder} (${category})`);
            
            // [v1.9.1] Use fetchHistoryDirect for faster & more reliable sync
            const result = await fetchHistoryDirect(rootFolder, category);
            
            if (result.success) {
                console.log(`[TokiSync] Received ${result.data.length} history items via Direct API`);
                if (result.data.length > 0) {
                    await markDownloadedItems(result.data);
                } else {
                    console.log('[TokiSync] No history items found in Drive');
                }
            } else {
                // Fallback to Legacy GAS if Direct fails
                console.warn('[TokiSync] Direct history fetch failed, trying legacy GAS relay...');
                const legacyHistory = await fetchHistory(rootFolder, category);
                if (legacyHistory && legacyHistory.length > 0) {
                    await markDownloadedItems(legacyHistory);
                }
            }
        } catch (e) {
            console.warn('[TokiSync] History check failed:', e);
        } finally {
            isSyncing = false;
            lastSyncTime = Date.now();
        }
    };

    // -- 1. Initialize MenuModal -- [DIAG 레벨4: UI(FAB) 주입]
    if (__TD >= 4) new MenuModal({
        onDownload: () => {}, // Not used directly, specific methods below
        downloadAll: (forceOverwrite) => {
            const config = getConfig();
            tokiDownload(undefined, config.policy, forceOverwrite);
        },
        downloadRange: (spec, forceOverwrite) => {
            const config = getConfig();
            tokiDownload(spec, config.policy, forceOverwrite);
        },
        openViewer: openViewer,
        openSettings: () => showConfigModal(),
        toggleLog: () => logger.toggle(),
        getConfig: getConfig,
        setConfig: setConfig,
        getEpisodeRange: async () => {
            const parser = await ParserFactory.getParser();
            if (!parser) return { min: 1, max: 100 };
            
            const list = parser.getListItems();
            if (list.length > 0) {
                const first = parser.parseListItem(list[0]);
                const last = parser.parseListItem(list[list.length - 1]);
                const min = Math.min(parseInt(first.num), parseInt(last.num));
                const max = Math.max(parseInt(first.num), parseInt(last.num));
                return { min, max };
            }
            return { min: 1, max: 100 };
        },
        migrateFilenames: runFilenameMigration,
        migrateThumbnails: runThumbnailMigration,
        syncHistory: syncHistory,
        testNativeDownload: async () => {
            try {
                const testBlob = new Blob(["TokiSync Native Mode Test File"], { type: "text/plain" });
                await saveFile(testBlob, "test", "native", "txt", { folderName: "_Test" });
                return true;
            } catch (e) {
                console.error("[Native Test Failed]", e);
                return false;
            }
        },
        testExtraction: async () => {
            try {
                const logger = LogBox.getInstance();
                logger.show();
                logger.log('🧪 추출 테스트 시작...', 'Debug');
                
                const parser = await ParserFactory.getParser();
                if (!parser) {
                    logger.error('❌ 파서를 찾을 수 없습니다.', 'Debug');
                    return;
                }

                const siteInfo = await detectSite();
                // 현재 페이지(document)를 대상으로 추출 테스트
                const result = await extractEpisodeData(document, parser, siteInfo, false);
                
                console.log('[Debug Result]', result);
                
                if (result.urls && result.urls.length > 0) {
                    logger.success(`✅ 이미지 추출 성공: ${result.urls.length}개`, 'Debug');
                } else if (result.content) {
                    logger.success(`✅ 소설 추출 성공: ${result.content.length}자`, 'Debug');
                } else {
                    logger.warn('⚠️ 추출된 데이터가 없습니다. (뷰어 페이지가 아닐 수 있음)', 'Debug');
                }
                
                if (result.seriesTitle && result.seriesTitle !== "UnknownSeries") {
                    logger.log(`📚 작품명: ${result.seriesTitle}`, 'Debug');
                    logger.log(`🔖 에피소드: ${result.episodeTitle} (${result.episodeNum})`, 'Debug');
                }

            } catch (e) {
                LogBox.getInstance().error(`❌ 테스트 실패: ${e.message}`, 'Debug');
                console.error(e);
            }
        },
        downloadCurrent: async () => {
            const logger = LogBox.getInstance();
            try {
                logger.show();
                logger.log('🚀 현재 에피소드 다운로드 시작...', 'System');
                
                const siteInfo = await detectSite();
                const parser = await ParserFactory.getParser();
                if (!parser) throw new Error('파서를 찾을 수 없습니다.');

                // 1. 메타데이터 추출 (제목 등 확인용)
                const metadata = await extractEpisodeData(document, parser, siteInfo, false);
                const title = metadata.episodeTitle || "Current_Episode";
                const seriesTitle = metadata.seriesTitle || "Unknown_Series";

                // 1-b. 시리즈 메타(작가/줄거리/연재상태/장르) 추출
                const seriesMeta = (typeof parser.getSeriesMetadata === 'function') ? parser.getSeriesMetadata() : {};

                // 2. 빌더 생성 (카테고리에 따라)
                const isNovel = (siteInfo.category === 'Novel' || siteInfo.category === 'novel');
                let builder;
                let extension = 'cbz';
                if (isNovel) {
                    const novelFormat = getConfig().novelFormat || 'epub';
                    builder = novelFormat === 'txt' ? new TxtBuilder() : new EpubBuilder(seriesTitle, { author: seriesMeta.author || "" });
                    extension = novelFormat;
                } else {
                    builder = new CbzBuilder(title);
                }

                // 3. 임시 아이템 객체 생성 (processItem 호환용)
                const tempItem = {
                    title: title,
                    src: document.URL,   // processItem에서 item.src 참조 (API 복호화 포함)
                    url: document.URL,   // 하위 호환성 유지
                    num: metadata.episodeNum || "0000"
                };

                // 4. 단건 다운로드 실행 (현재 페이지의 document를 직접 전달)
                await processItem(tempItem, builder, siteInfo, null, parser, seriesTitle, document);

                // 5. 파일 생성 및 저장
                logger.log('💾 파일 생성 및 저장 중...', 'System');
                
                const zip = await builder.build({
                    series: seriesTitle,
                    title: title,
                    number: tempItem.num,
                    writer: seriesMeta.author || "",
                    author: seriesMeta.author || "",
                    summary: seriesMeta.summary || "",
                    status: seriesMeta.status || "",
                    tags: seriesMeta.tags || [],
                    category: siteInfo.category
                });
                
                const blob = await zip.generateAsync({ type: "blob", compression: getCbzCompression() });
                const filename = `${tempItem.num} - ${title}`;

                await saveFile(blob, filename, 'local', extension, { category: siteInfo.category });
                logger.success('✅ 다운로드 완료!', 'System');

            } catch (e) {
                logger.error(`❌ 다운로드 실패: ${e.message}`, 'System');
                console.error(e);
            }
        }
    });



    // -- 3. Bridge Listener --
    window.addEventListener("message", async (event) => {
        if (event.data.type === 'TOKI_BRIDGE_REQUEST') {
            const { requestId, url, options } = event.data;
            const sourceWindow = event.source;
            const origin = event.origin;

            if (!origin.includes("github.io") && !origin.includes("localhost") && !origin.includes("127.0.0.1")) {
                console.warn("[Bridge] Blocked request from unknown origin:", origin);
                return;
            }

            console.log(`[Bridge] Proxying request: ${url}`);

            try {
                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url: url,
                    headers: options.headers,
                    data: options.data,
                    responseType: options.responseType || undefined,
                    onload: async (res) => {
                        let payload = null;
                        if (res.response instanceof Blob) {
                            payload = await blobToArrayBuffer(res.response);
                        } else {
                            payload = res.responseText;
                        }

                        // [v1.7.0] Cross-tab 상태 갱신 인지: Viewer가 GAS에 뭔가 썼을 경우 (업로드 / 이력 갱신)
                        if (options.data && typeof options.data === 'string') {
                            if (options.data.includes('"type":"upload"') || options.data.includes('"type":"view_update_cache"')) {
                                if (typeof payload === 'string' && payload.includes('"status":"success"')) {
                                    if (typeof GM_setValue !== 'undefined') GM_setValue("TOKI_HISTORY_DIRTY", Date.now());
                                }
                            }
                        }

                        sourceWindow.postMessage({
                            type: 'TOKI_BRIDGE_RESPONSE',
                            requestId: requestId,
                            payload: payload,
                            contentType: res.responseHeaders.match(/content-type:\s*(.*)/i)?.[1]
                        }, origin, [payload instanceof ArrayBuffer ? payload : undefined].filter(Boolean));
                    },
                    onerror: (err) => {
                        sourceWindow.postMessage({
                            type: 'TOKI_BRIDGE_RESPONSE',
                            requestId: requestId,
                            error: 'Network Error'
                        }, origin);
                    }
                });
            } catch (e) {
                console.error("[Bridge] Error:", e);
                sourceWindow.postMessage({
                    type: 'TOKI_BRIDGE_RESPONSE',
                    requestId: requestId,
                    error: e.message
                }, origin);
            }
        }
    });

    // Initial load -- [DIAG 레벨3: 히스토리 동기화/파서/마킹 + 큐 + 원격]
    console.log('[TokiSync] Starting history sync...');
    if (__TD >= 3) syncHistory();

    // -- 다중 시리즈 자동 큐 --
    if (__TD >= 3) registerQueueMenu();
    // 큐 실행 중이면: 현재 시리즈 전체 다운로드 후 다음 시리즈로 자동 이동 (저장된 정책 사용)
    // 큐 항목이 lease unit(unitId 있음=회차 1개)이면 "현재 회차만" 단일 다운로드,
    // 아니면(레거시: 시리즈 URL) 전체 시리즈 다운로드.
    if (__TD >= 3) maybeRunQueue((item) =>
        (item && item.unitId)
            ? downloadSingleEpisode(policyToDestination(getConfig().policy), item)
            : tokiDownload(undefined, getConfig().policy, false)
    );

    // -- 원격 제어 (컨트롤 API 폴링) --
    if (__TD >= 3) registerRemoteMenu();
    if (__TD >= 3) startRemoteSync();

    // Cross-tab sync listener
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            if (typeof GM_getValue !== 'undefined') {
                const dirtyTime = GM_getValue("TOKI_HISTORY_DIRTY", 0);
                if (dirtyTime > lastSyncTime) {
                    console.log(`[TokiSync] 다른 탭에서 이력 갱신 감지! 백그라운드 새로고침 수행...`);
                    syncHistory();
                }
            }
        }
    });
}
