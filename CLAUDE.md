# CLAUDE.md — tokiSync 운영/세션 가이드

> 아키텍처/설계 SSOT는 **`AI_AGENT_CONTEXT.md`** 참조. 이 파일은 **상시 서비스·빌드·배포·
> 브라우저 환경·안티탐지 교훈** 등 세션 운영에 필요한 실무 내역을 모은다.

## 🟢 상시 가동 서비스

| 서비스 | 상태 | 포트/경로 | 비고 |
|---|---|---|---|
| **유저스크립트 LAN 서빙** | **항상 켜짐** | `python3 -m http.server 8765` (cwd = 프로젝트 루트, bind `0.0.0.0`) | win-c(Windows)에서 설치/업데이트 소스 |
| **원격 제어 컨트롤 API** | **기본 꺼짐** | `server/control-api.js` 포트 **8787** | 필요 시 `cd server && node control-api.js` |

- **호스트 LAN IP:** `192.168.0.100` (robocom 리눅스).
- **유저스크립트 설치/업데이트 URL:** `http://192.168.0.100:8765/docs/tokiSync.user.js`
  - 빌드 산출물(`docs/tokiSync.user.js`)이 곧 설치 소스. 8765 서버가 루트를 서빙하므로 `/docs/...` 경로.
  - **8765 서버는 이미 떠 있으니 새로 띄우지 말 것**(중복 바인드 방지).
- 원격 제어는 **VPN 내부망 전제**(외부 노출/터널 없음). 토큰(`server/config.json`) 설정 권장.

## 빌드 / 배포

```bash
npm run build:core      # webpack → docs/tokiSync.user.js (유저스크립트 본체)
# (전체: npm run build = viewer + core + gas)
```
- **버전 컨벤션:** `1.20.5-custom.YYMMDD-N` (예: `1.20.5-custom.260531-3`). 배너는 `webpack.core.config.cjs`의 `@version`에 하드코딩 → 빌드 전 수동 증가.
- **현재 배포 버전:** `1.20.5-custom.260531-3`.
- **@updateURL 없음** → Tampermonkey "업데이트 확인"이 자동으로 못 받아올 수 있음. 그 경우
  설치 URL을 브라우저로 직접 열어 재설치. (자동 업데이트 원하면 빌드 배너에 `@updateURL`/`@downloadURL`을 8765 URL로 추가)

## 브라우저 자동화 환경 (Claude-in-Chrome)

- **대상 브라우저: `win-c`** (Windows, deviceId `305e3068-b67d-4987-9ffc-756af44a4151`). 여러 브라우저가 붙어 있으면 이걸 select.
- ⚠️ **Tampermonkey 등 확장 페이지(`chrome-extension://`)는 접근/스크린샷/클릭 불가** → 유저스크립트 **설치·업데이트 클릭은 사용자 몫**. 에이전트는 빌드/서빙/검증까지만.
- 실측 검증 패턴(만화 페이지에서 JS):
  - `ntk_blk`(localStorage) = 차단 플래그, `manhwaImgCount`(toonflix.app/manhwa/ 이미지 수), 본문 "일시적 오류" 텍스트 유무.
  - 정상 = `ntk_blk:null` + 오류 없음 + 이미지>0.

## sbxh(뉴토끼) 안티-탐지 교훈 (중요)

- **사이트 구조:** Next.js SPA + `disable-devtool` + **광고-ack 게이트**(`/api/manhwa-images`가
  `ad_ack_required` 반환, `/api/ad/challenge` slotCount=4·minSeen=2) + **prototype-tamper 탐지**
  (`/api/m/ev`로 `reason:prototype_tampered`/`userscript_spoof` 보고 → `ntk_blk` 차단). `console.clear()`로 콘솔 지움.
- **읽기 미로드 근본원인(해결됨):** tokiSync가 document-start에 `Element.prototype.attachShadow`
  Proxy를 **전역 설치**(닫힌 shadow 강제 open)한 게 사이트 변조탐지에 걸려 광고-ack 차단.
  → **워커 전용 + 기본 OFF**(`GM TOKI_FORCE_OPEN_SHADOW`)로 수정. 커밋 `cc5ffb5`/`8f245ba`.
- **지문 회피:** 디버그 로그를 페이지 localStorage→`GM_setValue`로 이전, DOM id `toki-*`→`dsx-*`. 커밋 `1da1ed5`. (단, 이름지문이 차단의 직접 원인은 아니었음 — 행동/변조 탐지가 핵심.)
- **진단 게이트:** `localStorage['__toki_diag']` 0~4 (0=무실행 … 4=풀, 기본 99). 이등분 디버깅용.
- **다운로드:** 정상 동작 확인됨(정상 크기/세션에서 광고-ack 통과). 워커 팝업이 너무 작거나 헤드리스면 광고-ack 실패 가능.

## 멀티-IP 병렬 다운로드

- 원래 IP + Surfshark VPN IP를 **Chrome 프로필 2개**(확장 OFF / ON)로 병렬화하는 설계·구현 플랜:
  **`documentation/MULTI_IP_DOWNLOAD_ORCHESTRATION.md`** (기존 컨트롤 서버를 lease 오케스트레이터로 확장).

## 브랜치 / 워크트리

- 작업 브랜치: **`feature/lan-custom-build`** (LAN 커스텀 빌드).
- 코드 변경은 워크트리에서 → 커밋 → `feature/lan-custom-build`로 fast-forward 머지.
- `docs/tokiSync.user.js`는 git-ignore된 빌드 산출물. `.omc/`도 ignore.
- 최근 핵심 커밋: `1da1ed5`(지문) → `cc5ffb5`(attachShadow 워커스코프) → `8f245ba`(워커 proxy 기본OFF) → `d0081b7`(멀티-IP 플랜).
