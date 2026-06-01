# v1.21.0 마이그레이션 노트 — 멀티-IP + NAS 재이식

> 베이스: upstream/main `603666b` (v1.21.0 — 워커 재설계 + 멀티큐 + 스텔스 + recycling + 세마포어/jitter)
> 목표: 원본 v1.21.0 흐름을 따라가며 우리 커스텀 중 **멀티-IP 병렬**과 **네이티브 NAS(WebDAV)** 만 재이식.
> 이전 브랜치 `feature/lan-custom-build` 는 보존(롤백/참조용).

---

## ✅ 이번 마이그레이션에서 **가져오는** 것

### 통째 이식 (upstream에 없는 우리 신규)
- `server/` 전체 — 멀티-IP lease 컨트롤 API + 대시보드 (control-api, store, telegram, util, public/)
- `src/core/webdav.js` — 네이티브 NAS WebDAV 업로드
- `src/core/utils.js` saveFile 에 `webdav` 분기 추가 (upstream은 local/native만)
- `src/core/remote.js` — ⚠️ **upstream queue API 어댑터로 재작성** (`/lease`→`addEpisodesToQueue`, `WORKER_STAGE.COMPLETED`→`/complete`)
- 빌드/설정: `webpack.core.config.cjs` LAN 배너 + 8765 `@updateURL`, `CLAUDE.md`, config(NAS/remote 설정)

### upstream 흐름에 반영 (우리 고유 가치)
- 폴더명·회차번호·제목·표지(cover.jpg)·시리즈메타(작가/소개/상태/**tags**/summary 폴백) 동봉
- `getParserForUrl(url)` — 부모 페이지 무관 소설/만화 룰 분기
- `getSeriesMetadata(root=document)` — doc 인자화(자동펼침 정확 추출)
- 자동 펼침(`extractChapterItemsFromDoc`)

---

## ⛔ 이번에 **제외/폐기**하는 것 (upstream 것 채택 — 중복/열위)

| 우리 커스텀 | 폐기 사유 (upstream 대체) |
|---|---|
| force-open shadow 스텔스 (e75e2e7/df55544/a98ad17), attachShadow Proxy (1da1ed5/cc5ffb5/8f245ba) | upstream `worker-extractor.js` 초스텔스 우회 엔진이 대체 |
| WAF 지터 (78d83c4) | upstream jitter(1.5~3s) 스케줄러 |
| 단일/벌크 자동 큐 (cfdb429), 큐 이동 지연 (7c2130d) | upstream 멀티큐 v2.0.0 |
| 부모 탭 고정 + runLeaseQueue (946b383/58c1d40) | upstream 워커 recycling + 세마포어(MAX_CONCURRENCY=2) |
| 만화 이미지 2개 SSR 복구 (22187fe/93fb5a5) | upstream worker-extractor가 shadow innerHTML 복구 보유 (동시성2+스텔스로 광고-ack 스트립 자체가 거의 안 생길 것으로 추정) |
| direct Drive PATCH (57c819a) | upstream `network.js` "Direct Drive Access Module" 이미 보유 |

---

## ⏸️ **보류** — 추후 적용 검토 (이번 제외, 가치 있음)

### 1. 멀티-IP를 별도 유저스크립트로 분리
- 현재: 멀티-IP를 메인 유저스크립트에 통합.
- 추후안: 멀티-IP 오케스트레이션(lease/complete/progress/대시보드 연동/자동펼침)을 **별도 `.user.js`로 분리**.
- 제약: Tampermonkey GM 저장소가 스크립트별 격리 → 메인의 큐(`addEpisodesToQueue`)를 직접 못 건드림.
  - 통신: 메인에 **CustomEvent 수신 훅**(`tokisync:enqueue` → addEpisodesToQueue, 완료 시 `tokisync:completed` 발신) 수십 줄 추가 필요.
  - NAS/명명/표지/메타는 추출·저장 로직이라 분리 불가 → 메인 통합 유지.
- 장점: upstream 업데이트 따라가기 쉬움, 멀티-IP 미사용 환경은 메인만 설치.
- 단점: 이벤트 브리지 통신 + 설정 GM 분리 + 디버깅 복잡.

### 2. 만화 SSR 복구 (보험)
- upstream 스텔스로 "이미지 2개 스트립"이 재발하면 22187fe/93fb5a5 로직을 worker-extractor에 보강.

### 3. 업로드 병렬 파이프라인 (2d2a5d1)
- upstream 저장 흐름엔 병렬 업로드 없음. NAS 대량 업로드 시 유용 → NAS 이식 안정화 후 검토.

### 4. 회차목록 0개 오탐 방지 (eb49aa1)
- upstream `getListItems`는 container 대기만(`waitForSelector`). 항목 0개 대기는 불명확 → 소설에서 0개 오탐 재발 시 소폭 보강.

---

## 진행 단계 (순차)
1. ✅ 새 브랜치 `feature/v1.21-multi-ip` (upstream/main 베이스) + 본 문서
2. NAS 이식: `webdav.js` + `utils.js` saveFile webdav 분기 + config
3. server/ + 대시보드 이식 (독립, 빌드 무관)
4. `remote.js` 어댑터 재작성 (upstream queue 연동) ← 최대 난관, 브라우저 실측 필요
5. 명명/표지/메타 동봉을 upstream `addEpisodesToQueue`/저장 경로에 반영
6. 빌드/검증 + win-c 실측
