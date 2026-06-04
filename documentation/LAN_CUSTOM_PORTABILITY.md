# LAN Custom Upstream Merge Notes

이 브랜치는 업스트림 업데이트를 쉽게 받기 위해 LAN/NAS/remote 커스텀 코드를 별도 helper에 모은다.

## Keep Local Code Here

- `src/core/lan-custom-config.js`
  - LAN 설정 키
  - NAS/WebDAV 설정 값
  - remote lease 설정 값
  - `scanSpeed` 하위 호환 변환
  - custom rule JSON 검증
- `src/core/lan-custom-ui.js`
  - 통합 대시보드의 NAS/WebDAV 섹션
  - remote lease 설정 섹션
  - remote/custom rule 입력 섹션
  - 설정 초기화/자동 저장/저장 버튼 처리
- `src/core/lan-custom-runtime.js`
  - remote GM 메뉴 등록 hook
  - remote polling/runtime 시작 hook
  - NAS native 저장 테스트 hook
- `src/core/lan-custom-storage.js`
  - `native`/`webdav` 저장 정책을 NAS WebDAV 업로드로 연결
  - 저장 카테고리 기본값 계산
- `src/core/lan-custom-queue.js`
  - lease 큐 item 메타 보강(`unitId`, `cover`, `meta`, `series`, `reported`)
  - lease terminal item 재투입 시 pending 복원
  - lease 동시 실행 수 제한
  - orphan processing 복구와 팝업 slot 재사용 보조
- `src/core/lan-custom-worker.js`
  - batch worker 정체 복구 정책
  - worker diagnostic summary/로그 필터
  - remote poll wake 신호
  - lease item의 terminal popup 보존 정책
- `src/core/lan-custom-extraction.js`
  - worker popup 진단 수집 payload
  - LAN 저장 카테고리/저장 경로 계산
  - lease cover/meta를 EPUB/CBZ builder metadata로 변환
- `build/lan-custom.cjs`
  - LAN userscript metadata
  - package component version fallback

## Expected Upstream Touch Points

업스트림 파일에는 아래 hook만 유지한다.

- `src/core/config.js`
  - `lan-custom-config.js` import/re-export
  - `...getLanConfigValues(GM_getValue)`
  - `getRemoteConfig()` wrapper
  - legacy modal custom rule validation에서 `parseCustomRulesJson()`
- `src/core/ui.js`
  - `lan-custom-ui.js` import
  - `${renderLanDashboardSettingsHtml()}`
  - `${renderLanRuleSettingsHtml()}`
  - `getLanSettingsElements()`
  - `populateLanSettings()`
  - `bindLanSettingsAutoSave()`
  - `saveDashboardSettings()`
- `src/core/main.js`
  - `registerLanCustomMenus()`
  - `startLanCustomRuntime()`
  - `testLanNativeDownload(saveFile)`
- `src/core/utils.js`
  - `tryLanSaveFile()` before upstream local/drive persistence
- `src/core/queue.js`
  - `extendLanQueueItem()`
  - `getLanQueueItemMetadataUpdates()`
  - `recoverLanOrphanProcessing()`
  - `shouldBlockForLanQueuePolicy()`
  - `focusLanWorkerPopup()` / `markLanPopupSlotReused()`
- `src/core/worker-controller.js`
  - `lan-custom-worker.js` helper imports for stall recovery, diagnostics, remote wake, popup close policy
- `src/core/worker-extractor.js`
  - `lan-custom-extraction.js` helper imports for diagnostics, metadata, save target
- `webpack.core.config.cjs`
  - `resolveComponents()`
  - `resolveLanUserscriptMetadata()`
- `vite.config.js`
  - `resolveComponents()`

## Merge Checklist

1. Merge upstream in a clean worktree.
2. Keep helper files above as the LAN source of truth.
3. If upstream rewrites a touch point, reapply only the hook calls listed above.
4. Do not copy long NAS/remote/lease policy blocks back into upstream files.
5. Verify:

```bash
npm test
node --check server/control-api.js
node --check server/lib/nas-webdav.js
node --check server/public/app.js
node --experimental-loader ./scratch/ignore-css-loader.mjs ./scratch/lease_regression_test.js
npm run build:core
npm run build:viewer
```

## Remaining Higher-Risk Area

- `src/core/downloader.js`
  - 아직 native/drive/local destination 결정과 개별 다운로드 저장 흐름을 upstream 로직 안에서 함께 처리한다.
  - 다음 분리 대상은 destination 결정 helper 또는 downloader storage adapter다.
