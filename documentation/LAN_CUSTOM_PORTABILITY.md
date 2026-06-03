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
- `webpack.core.config.cjs`
  - `resolveComponents()`
  - `resolveLanUserscriptMetadata()`
- `vite.config.js`
  - `resolveComponents()`

## Merge Checklist

1. Merge upstream in a clean worktree.
2. Keep helper files above as the LAN source of truth.
3. If upstream rewrites `config.js` or `ui.js`, reapply only the hook calls listed above.
4. Do not copy long NAS/remote settings blocks back into upstream files.
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

## Remaining Higher-Risk Areas

아래 파일은 아직 동작 자체가 업스트림과 로컬 기능을 동시에 품고 있어 충돌 가능성이 남아 있다.

- `src/core/worker-controller.js`
- `src/core/worker-extractor.js`
- `src/core/queue.js`
- `src/core/downloader.js`

이 파일들은 기능 안정화 후 별도 adapter로 더 분리할 수 있다.
