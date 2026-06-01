# CLAUDE.md — tokiSync 운영/세션 가이드

> 아키텍처/설계 SSOT는 **`AI_AGENT_CONTEXT.md`** 참조. 이 파일은 **상시 서비스·빌드·배포·
> 브라우저 환경·안티탐지 교훈·원격 작업(멀티-IP)** 등 세션 운영에 필요한 실무 내역을 모은다.

## 🟢 상시 가동 서비스

| 서비스 | 상태 | 포트/경로 | 비고 |
|---|---|---|---|
| **유저스크립트 LAN 서빙** | **항상 켜짐** | `python3 -m http.server 8765` (cwd = 프로젝트 루트, bind `0.0.0.0`) | win-c(Windows)에서 설치/업데이트 소스 |
| **원격 제어 컨트롤 API** | **필요 시 가동** | `server/control-api.js` 포트 **8787** | `node server/control-api.js` (zero-dep). 멀티-IP lease 오케스트레이터 |

- **호스트 LAN IP:** `192.168.0.100` (robocom 리눅스).
- **유저스크립트 설치/업데이트 URL:** `http://192.168.0.100:8765/docs/tokiSync.user.js`
  - 빌드 산출물(`docs/tokiSync.user.js`)이 곧 설치 소스. 8765 서버가 루트를 서빙하므로 `/docs/...` 경로.
  - **8765 서버는 이미 떠 있으니 새로 띄우지 말 것**(중복 바인드 방지).
- 컨트롤 API는 **VPN 내부망 전제**(외부 노출/터널 없음). 토큰(`server/config.json`의 `token`) 설정 권장,
  내부망이면 **open 모드(토큰 빈값)**도 허용. config.json은 git 무시(시크릿).

## 빌드 / 배포

```bash
npm run build:core      # webpack → docs/tokiSync.user.js (유저스크립트 본체)
# (전체: npm run build = viewer + core + gas)
```
- **버전 컨벤션:** `1.20.5-custom.YYMMDD-N` (예: `1.20.5-custom.260601-4`). 배너는 `webpack.core.config.cjs`의 `@version`에 하드코딩 → 빌드 전 수동 증가.
- **현재 배포 버전:** `1.20.5-custom.260601-4`.
- **✅ 자동 업데이트 지원(260601-1+):** 빌드 배너에 `@updateURL`/`@downloadURL`을 8765 URL로 추가함.
  → Tampermonkey 대시보드 → **유틸리티 → "유저스크립트 업데이트 확인"** 으로 **전 프로필 자동 갱신**(수동 재설치 불필요).
  날짜 segment 증가(`260601` > `260531`)로 TM의 "더 새 버전" 감지가 안정적. (단, `@updateURL`이 없던 옛 설치본은 마지막으로 1회 수동 재설치 필요.)

## 원격 작업 / 멀티-IP 병렬 다운로드 (구현 완료)

`documentation/MULTI_IP_DOWNLOAD_ORCHESTRATION.md` 설계를 **lease/claim work-stealing 모델**로 구현.
원래 IP + Surfshark VPN IP를 Chrome 프로필 여러 개로 병렬화 → 회차를 겹침 없이 나눠 다운로드.

### 서버(`server/`) — 컨트롤 API 엔드포인트
| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/api/health` | 헬스체크(인증 불필요). `auth:false`면 open 모드 |
| POST | `/jobs` `{series, urls[]}` 또는 `{series, units:[{url,num,label}]}` | 회차 unit enqueue(멱등). **units** 형은 시리즈 목록의 권위 번호/제목 동봉 |
| POST | `/jobs/expand` `{seriesUrl, series}` | 작품 메인 URL 자동 펼침 요청(서버 보관 → 클라가 처리) |
| POST | `/jobs/clear` | 작업 풀 전체 비우기 |
| GET | `/lease?clientId=X&max=N` | pending unit N개 원자적 임대(만료시각 부여) |
| POST | `/complete` `{clientId, results:[{id,ok}]}` | done/failed 처리(실패→재투입, attempts 상한 시 failed) |
| POST | `/pause` · `/resume` | 전체 정지(새 lease 중단)·재개 |
| GET | `/clients` | 풀 요약 + 클라이언트별 online/IP/진행 + `paused` |
| GET | `/units?status=` · POST `/requeue` `{ids}` | unit 목록 / 강제 재투입 |
| POST | `/progress` `{clientId,...}` | 클라별 heartbeat(lease TTL 갱신). 응답에 `expansions`·`paused` 동봉 |
| POST | `/captcha` `{clientId,...}` | 캡차 시 해당 클라 lease 격리 재투입 + 텔레그램 |
| (레거시) | `/queue*` | 단일 클라 모드(clientId 없을 때 하위호환) |

config.json 추가키: `leaseTtlMs`(기본 120000), `leaseMax`(기본 4). 텔레그램: `telegram.scriptPath`(기존 telegram-noti.sh) 또는 `botToken`+`chatId`.

### 사용 절차
1. **서버 기동**(robocom): `node server/control-api.js`. 토큰 쓰려면 `config.json`에 `token` 작성(open 모드면 생략).
2. **대시보드**(폰/노트북, 같은 VPN망): `http://192.168.0.100:8787/` → ⚙️ 연결 설정에 토큰 입력(있으면).
3. **win-c 유저스크립트**(프로필마다): Tampermonkey → 🌐 원격 제어 설정 → URL/토큰 + **클라이언트 ID**(예: `A-direct`/`B-vpn`)·동시 보유 작업수(leaseMax). clientId 있으면 lease 모드.
   - ⚠️ **토큰은 대시보드·유저스크립트 각각 따로 저장**(공유 안 됨). open 모드면 어디에도 불필요.
4. **작업 투입(둘 중 하나):**
   - **📤 유저스크립트 버튼**(권장): 작품 메인 페이지에서 Tampermonkey 메뉴 "📤 이 작품 전체 회차 → 원격 풀 투입". 라이브 파서로 **정식 폴더명·회차 번호·제목**을 동봉(외전·소수회차도 정확).
   - **대시보드 자동 펼침**: "⚡ 작품 메인 URL 자동 펼침"에 URL → 온라인 클라가 회차 펼쳐 투입(번호/제목은 best-effort).
5. **모니터링/제어:** 멀티-IP 작업 풀 패널(풀 막대·클라이언트 카드) + ⏸️전체 정지/▶️재개 + 🗑️풀 비우기 + 실패/멈춤 재투입.

### 동작 보장
- **중복 방지:** done unit 재임대 안 됨, enqueue 멱등(정규화 url 키). **유실 방지:** lease TTL 만료/실패 → 재투입(attempts 상한 시 failed). **원자성:** Node 단일스레드 동기 처리.
- **회차 1개 = 단일 다운로드:** lease unit은 회차 페이지로 가서 `downloadSingleEpisode`(전체 시리즈 아님). 폴더명·회차번호·제목은 **메인 페이지(expand 시점)에서 계산해 unit에 동봉** → 회차 페이지에서 못 뽑는 작품명/외전번호를 보존. NAS 경로 `<webdav>/<category>/[id] 작품명/NNNN - 제목.cbz`.

## 브라우저 자동화 환경 (Claude-in-Chrome)

- **대상 브라우저: `win-c`** (Windows, deviceId `305e3068-b67d-4987-9ffc-756af44a4151`). 여러 브라우저가 붙어 있으면 이걸 select.
- ⚠️ **Tampermonkey 등 확장 페이지(`chrome-extension://`)는 접근/스크린샷/클릭 불가** → 유저스크립트 **설치·업데이트·🌐설정 모달은 사용자 몫**(GM 메뉴/GM 저장소는 page context에서 못 건드림). 에이전트는 빌드/서빙/검증까지만.
- 실측 검증 패턴(만화 페이지에서 JS):
  - `ntk_blk`(localStorage) = 차단 플래그, `main.vw-main img`(이미지 수), 본문 "일시적 오류" 텍스트 유무.
  - 정상 = `ntk_blk:null` + 오류 없음 + 이미지>0.
- **페이지 내 `fetch`(same-origin, credentials:'include')는 Cloudflare 통과**(cf_clearance 쿠키+브라우저 지문) → 시리즈 HTML 수신에 사용. `GM_xmlhttpRequest`는 지문 부족으로 **403 challenge**(서버 curl도 403).

## sbxh(뉴토끼) 안티-탐지 & 다운로드 교훈 (중요)

- **사이트 구조:** Next.js SPA(`sbxh3.com`) + Cloudflare + `disable-devtool` + **광고-ack 게이트**
  (`/api/ad/challenge` slotCount=4·minSeen=2) + **prototype-tamper 탐지**(`/api/m/ev` → `userscript_spoof` → `ntk_blk`). 이미지 CDN = `i.toonflix.app/board_uploads/...`.
- **닫힌 shadow & force-open (`TOKI_FORCE_OPEN_SHADOW`):**
  - 만화 본문은 SSR light DOM(이미지), **소설 본문은 닫힌(closed) shadow DOM에 봉인**(`article.novel-viewer > div[style*=--novel-font-size]`).
  - 소설 추출엔 force-open 필수지만 **모든 닫힌 shadow를 열면** sbxh의 탐지 probe까지 열려 ntk_blk. → **URL이 `/novel/`일 때 자동 ON + 본문 호스트 shadow만 선택적 open**(probe는 닫힌 채로). 만화 URL(`/manhwa·/manga·/webtoon`)은 OFF. 수동 오버라이드는 GM `TOKI_FORCE_OPEN_SHADOW`. 커밋 `e75e2e7`/`df55544`/`a98ad17`.
- **소설 API(Plan C)는 stale:** `/api/novel-content` 토큰에 nonce 없음 + `/api/ad/challenge` 선행 필요 + XOR 스킴 변경 → 현재 코드 복호화 불가. force-open으로 렌더된 본문 읽기가 유일.
- **만화 "이미지 2개만" 문제:** 워커 팝업이 작아 광고-ack 실패 시 sbxh 클라가 렌더 DOM을 2개로 스트립. → 워커가 **SSR HTML(전체 이미지 보존)** 을 파싱해 복구. 커밋 `22187fe`/`93fb5a5`.
- **진단 게이트:** `localStorage['__toki_diag']` 0~4 (이등분 디버깅용).

## 브랜치 / 워크트리

- 작업 브랜치: **`feature/lan-custom-build`** (LAN 커스텀 빌드).
- 코드 변경은 워크트리에서 → 커밋 → `feature/lan-custom-build`로 fast-forward 머지.
- `docs/tokiSync.user.js`는 git-ignore된 빌드 산출물. `.omc/`·`.claude/`·`server/config.json`도 ignore.
- **최근 핵심 커밋 흐름(이번 세션):**
  - 멀티-IP lease: `336dc6b`(서버 코어) → `ab38c46`(유저스크립트 어댑터) → `bdbb133`(대시보드) → `25c3e32`(하드닝)
  - 소설: `eb49aa1`(목록 0개 오탐) → `e75e2e7`/`df55544`/`a98ad17`(닫힌 shadow 본문) → `e645a0a`(EPUB Kavita 메타)
  - 만화: `93fb5a5`/`22187fe`(이미지 전체 수신)
  - 자동 펼침/정지: `02dbb5b`/`4b8030b`(작품 URL 펼침) → `729e6f0`(단일회차+정지/재개)
  - 명명: `3bc30d5`(제목 파싱) → `9005771`(폴더명 동봉) → `3664043`(번호/제목 동봉)
  - 운영: `135a7f3`(자동 업데이트) → `340373e`(대시보드 pill)
