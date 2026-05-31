# 멀티-IP 병렬 다운로드 오케스트레이션 설계 / 구현 플랜

> 상태: **설계 확정, 미구현**. 새 세션에서 이 문서를 읽고 구현한다.
> 대상 브랜치: `feature/lan-custom-build`
> 작성 근거: 실제 코드(`server/control-api.js`, `server/lib/store.js`, `src/core/remote.js`, `server/public/`) 정독 기준.

---

## 1. 목표 / 배경

한 PC(win-c)에서 **원래 IP + Surfshark VPN IP**를 동시에 사용해 sbxh(뉴토끼) 만화를
**병렬 다운로드**한다. 사이트의 광고-ack(`ad_ack_required`)·dev-block·레이트리밋은 **IP 단위**로
적용되므로, 서로 다른 출구 IP의 클라이언트 2개(이상)는 독립 버킷 → 실효 처리량 ~N배.

- **네트워크 구성(이미 결정됨):** Chrome **프로필 2개**.
  - 프로필 A = 서퍼샤크 확장 OFF → 원래 IP
  - 프로필 B = 서퍼샤크 **Chrome 확장 ON**(프로필 단위 프록시) → VPN IP
  - 각 프로필에 Tampermonkey + tokiSync 별도 설치 (독립 `ntk_pid`/세션).
- **오케스트레이션 필요성:** 두 프로필이 **같은 회차를 중복 다운로드하면 안 됨**. 작업을
  겹치지 않게 분배하고 진행률을 통합 모니터링할 "조정자(orchestrator)"가 필요하다.
  → **기존 원격 제어 서버(`server/`)를 확장**해 이 역할을 맡긴다.

---

## 2. 현재 아키텍처 (코드 기준, 정확)

```
[대시보드(폰/노트북)] ──VPN내부망──> [컨트롤 API :8787] <──폴링── [tokiSync 유저스크립트]
                                          │ 캡차 감지 → 텔레그램
```

### 2.1 서버 (`server/control-api.js`, zero-dependency Node http, 포트 8787)
엔드포인트:
| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/queue?since=<seq>` | 대시보드/유저스크립트 공용. seq 이후 명령 증분 + 상태 스냅샷 반환 |
| POST | `/queue` `{urls:[]}` | 다운로드 명령 추가(`add`) |
| POST | `/queue/start` `/stop` `/clear` | 큐 제어 명령 추가 |
| POST | `/queue/remove` `{url}` | 큐에서 항목 제거 명령 |
| POST | `/progress` `{queue,running,progress}` | 유저스크립트 진행률 미러 보고 |
| POST | `/captcha` `{message,url}` | 캡차 감지 → 텔레그램 알림 |
| GET | `/` (+ `/status`) | 대시보드 정적 파일 / 상태 |

인증: `X-Toki-Token` 또는 `Bearer`(`config.token`). 토큰 미설정 시 오픈 모드(경고).

### 2.2 상태 저장 (`server/lib/store.js`)
```
state = {
  seq: number,                 // 단조 증가 명령 시퀀스
  commands: [{seq,type,payload,ts}],   // append-only 명령 로그 (최대 200)
  report: {queue,running,progress,ts}, // ⚠️ 단일 슬롯 (마지막 보고로 덮어씀)
  captcha: [{ts,message,url}],
}
```
- 명령은 `addCommand` → seq 부여 → 디스크 영속(`data/state.json`).
- `commandsSince(since)` = seq > since 인 명령만.
- `report`는 휘발성(디스크 안 씀), `snapshot()`이 online 여부 계산.

### 2.3 유저스크립트 어댑터 (`src/core/remote.js`)
- 설정 키(`src/core/config.js`): `TOKI_REMOTE_ENABLED`, `TOKI_REMOTE_API_URL`,
  `TOKI_REMOTE_API_TOKEN`, `TOKI_REMOTE_POLL_SEC`(기본 5).
- `startRemoteSync()` → `poll()`을 pollSec 간격 반복.
- `poll()` = `GET /queue?since=lastSeq` → 받은 `commands`를 `applyCommand()`로 적용
  (`add`→큐에 URL 추가, `remove`/`start`/`stop`/`clear`) → `POST /progress`로 로컬 큐/진행 미러.
- 캡차 감지 시 `POST /captcha`.

---

## 3. 공백 — 왜 현재로는 오케스트레이션이 안 되나

1. **글로벌 명령 스트림:** `GET /queue?since=seq`는 **모든** 클라이언트에게 **같은** 명령을
   반환한다. 프로필 2개가 폴링하면 **둘 다 같은 `add` 명령을 받아 같은 회차를 중복 다운로드**한다.
2. **단일 `report` 슬롯:** 진행률 보고가 한 칸이라 **마지막 보고가 덮어씀** → 클라이언트별
   진행률 구분 불가.
3. **클라이언트 식별 없음:** 누가 무엇을 하는지 서버가 모름 → 작업 분배/요청 불가.

---

## 4. 설계 — 권장: **claim/lease 작업 분배 (work-stealing)**

겹침 없이 자동 부하분산되고, 실패/캡차/오프라인 시 자동 재투입되는 **임대(lease) 모델**.

### 4.1 핵심 개념
- **작업 단위(unit):** 다운로드의 최소 단위 = **회차 1개(또는 URL 1개)**. 대시보드가
  "작품 X 1~431화"를 enqueue → 서버가 **회차별 unit으로 펼침**.
- **unit 상태:** `pending → leased(clientId, expiresAt) → done | failed(→pending 재투입)`.
- **클라이언트 식별:** 모든 클라이언트 요청에 `clientId`(예: `A-direct`, `B-vpn`) 포함.
- **임대(lease):** 클라이언트가 "일감 N개 줘" → 서버가 **pending unit N개를 원자적으로 leased**로
  바꿔 그 클라이언트에 배정(만료시각 부여). 한 unit은 동시에 한 클라이언트만.
- **완료/실패 보고:** 클라이언트가 unit 완료/실패 보고 → done 처리 or pending 재투입.
- **lease TTL & 재투입:** `expiresAt` 경과(클라 죽음/캡차/오프라인) → 자동 pending 복귀
  → 다른 클라이언트가 가져감. **중복·유실 방지의 핵심.**

> 대안(단순): 명령에 `target: clientId`를 달아 정적 범위 배정(A=홀수화, B=짝수화).
> 구현은 쉽지만 부하 불균형·실패 재투입이 약함. **lease 모델을 권장**(겹침/유실/장애에 강함).
> 단, 1차 MVP는 정적 배정으로 빠르게 검증 후 lease로 승급해도 됨.

### 4.2 데이터 모델 확장 (`store.js`)
```js
state = {
  ...기존,
  units: [                       // 작업 풀
    { id, url, series, label, status:'pending'|'leased'|'done'|'failed',
      clientId:null, leasedAt:0, expiresAt:0, attempts:0, ts }
  ],
  reports: {                     // ⚠️ report → clientId별 맵으로
    [clientId]: { label, ip, queue, running, progress, current:[unitId], ts }
  },
}
```
- 영속: `units`는 디스크 저장(재시작 복원), `reports`는 휘발성 유지.
- 멱등 enqueue: 같은 url unit 중복 추가 방지(키 = 정규화 url).

### 4.3 API 변경/추가
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/jobs` `{series,urls[]\|range}` | 작업 enqueue → 회차 unit으로 펼쳐 `units`에 추가(멱등) |
| GET | `/lease?clientId=X&max=N` | pending unit 최대 N개를 원자적으로 X에 임대(만료 부여) 후 반환 |
| POST | `/complete` `{clientId,results:[{id,ok}]}` | unit done/failed 처리(실패→pending 재투입, attempts++) |
| POST | `/heartbeat` or 확장 `/progress` `{clientId,label,ip,...}` | 클라이언트별 진행/생존 보고 + 보유 lease 갱신 |
| GET | `/clients` | 대시보드용: 클라이언트별 online/label/ip/current/진행률 + 풀 요약(pending/leased/done) |
| (유지) | `/queue*`, `/captcha` | 하위호환(단일 클라이언트 수동모드) |

- **lease 원자성:** Node 단일스레드 + 동기 처리이므로 핸들러 내에서 "pending 골라 leased로
  표시"가 자연히 원자적. 락 불필요.
- **lease 만료 청소:** 폴링/요청 시점에 `now > expiresAt && status==='leased'` → `pending` 복귀.
- **captcha:** `/captcha`에 `clientId` 추가 → 해당 클라이언트의 보유 lease를 즉시 재투입(또는
  hold) + 텔레그램에 "어느 IP/프로필"인지 명시.

### 4.4 유저스크립트 어댑터(`remote.js`) 변경
- 설정 키 추가: `TOKI_REMOTE_CLIENT_ID`(예: `A-direct`), (옵션) `TOKI_REMOTE_LEASE_MAX`.
- `poll()` 흐름을 lease 기반으로:
  1. `GET /lease?clientId=&max=` → 받은 unit들을 로컬 다운로드 큐에 주입 → 기존 `tokiDownload`로 실행.
  2. 각 unit 완료/실패 시 `POST /complete`(clientId, results).
  3. 주기적으로 `POST /progress`(clientId, label, ip, 진행률, 보유 unit) → lease 갱신/생존.
  4. 캡차 → `POST /captcha`(clientId) → 해당 클라 일감 hold.
- `ip`는 클라이언트가 외부 IP 조회(예: 가벼운 `https://api.ipify.org`)해 라벨로 보고(식별/검증용, 선택).
- 하위호환: clientId 미설정 시 기존 글로벌 `/queue` 모드로 폴백.

### 4.5 대시보드(`server/public/`) 변경
- **작업 투입:** "작품 URL + 범위" 입력 → `POST /jobs`.
- **멀티 클라이언트 패널:** `GET /clients` 폴링 → 각 클라이언트(label/IP/online) 카드 +
  현재 unit + 진행바. 풀 요약(pending/leased/done/failed) 막대.
- **운영 버튼:** stuck lease 강제 재투입, 특정 클라 일시정지(hold), 전체 stop.

---

## 5. 운영 런북 — Surfshark 2-프로필

1. **서버 기동(robocom 또는 상시 호스트):** `cd server && node control-api.js` (포트 8787,
   `config.json`에 `token` 설정 권장). VPN 내부망에서 win-c가 `http://<서버IP>:8787` 접근.
2. **Chrome 프로필 A (원래 IP):**
   - 서퍼샤크 확장 **OFF/미설치**.
   - Tampermonkey + tokiSync 설치 → 🌐 원격 제어 설정: URL=`http://<서버IP>:8787`, 토큰,
     **clientId=`A-direct`**, 폴링 5s, enable.
3. **Chrome 프로필 B (VPN IP):**
   - 서퍼샤크 **Chrome 확장 ON** + 서버 연결(가능하면 **Static/Dedicated IP**: 공용 IP는
     이미 sbxh에 차단 이력 가능).
   - Tampermonkey + tokiSync 설치 → 원격 설정 동일하되 **clientId=`B-vpn`**.
4. **IP 검증:** 각 프로필에서 외부 IP가 실제로 다른지 확인(api.ipify.org 등).
5. **작업 투입:** 대시보드에서 "작품 + 범위" enqueue → 두 프로필이 `/lease`로 **겹치지 않는
   회차**를 가져가 동시 다운로드 → 같은 Drive에 업로드(서로 다른 파일이라 충돌 없음).
6. **모니터링:** 대시보드에서 클라이언트별 진행 + 풀 소진 확인. 캡차/차단 시 텔레그램.

---

## 6. 엣지 케이스 / 안전

- **중복 방지:** done unit은 재임대 안 됨. enqueue 멱등(정규화 url 키).
- **유실 방지:** lease TTL 만료/`/complete` 실패 → pending 재투입(attempts 상한 시 failed 격리).
- **IP별 레이트리밋:** 광고-ack/dev-block은 IP 단위 → 클라이언트별 독립. 단 **IP당 동시성은
  보수적으로**(tokiSync 회차 동시 처리 수/ WAF 지터). 한 IP를 너무 두드리면 그 IP만 차단됨.
- **캡차/차단 격리:** 한 클라가 캡차/차단 → 그 클라 lease만 hold/재투입, 다른 클라는 계속.
- **Drive 충돌:** unit = 서로 다른 파일이면 동시 업로드 OK. 같은 회차를 두 클라에 주지 않음(lease가 보장).
- **시계/만료:** 서버 `now()` 기준 lease 만료. 클라-서버 시계차 무관(서버 단일 기준).
- **보안:** 토큰 필수(오픈 모드 금지). 내부망 전제. clientId는 신뢰 라벨(스푸핑 가능하나 내부망).

---

## 7. 구현 단계 (Phases) & 수용 기준

**Phase 1 — 서버 lease 코어**
- `store.js`: `units`/`reports` 모델 + add/lease/complete/expire/requeue + 영속.
- `control-api.js`: `/jobs`, `/lease`, `/complete`, `/clients`, `/progress`·`/captcha`에 clientId.
- 수용: curl로 unit enqueue → 2개 clientId가 `/lease`로 **겹치지 않게** 가져감, `/complete`로 done,
  미완 lease가 TTL 후 재투입.

**Phase 2 — 유저스크립트 어댑터**
- `config.js`: `TOKI_REMOTE_CLIENT_ID`(+ lease max) 추가 + 원격 설정 모달 UI.
- `remote.js`: poll을 lease 기반으로 전환(+ 하위호환 폴백). 빌드(`npm run build:core`).
- 수용: 프로필 2개가 disjoint 회차 다운로드, 진행률 클라별 보고, 중복 업로드 0.

**Phase 3 — 대시보드**
- `/jobs` 투입 UI + 멀티 클라이언트 패널 + 풀 요약 + 운영 버튼.
- 수용: 실제 2-프로필(원IP+VPN)로 한 작품 분담 다운로드 + 모니터링 + 캡차 격리 확인.

**최종 게이트:** ai-slop-cleaner + verification + code-review → `feature/lan-custom-build` 머지.

---

## 8. 새 세션 시작 프롬프트 (복붙용)

```
documentation/MULTI_IP_DOWNLOAD_ORCHESTRATION.md 를 읽고 Phase 1부터 구현해줘.
기존 server/(control-api.js, lib/store.js) 와 src/core/remote.js·config.js 를 확장하는 방식.
lease/claim 작업분배 모델. 하위호환(단일 클라 /queue 모드) 유지. 브랜치 feature/lan-custom-build.
Phase 1 끝나면 curl 시나리오로 "2개 clientId 겹침 없음 + TTL 재투입" 검증부터 보여줘.
```

---

## 부록 A — 관련 파일 맵
- 서버: `server/control-api.js`(라우팅), `server/lib/store.js`(상태), `server/public/{index.html,app.js,style.css}`(대시보드), `server/lib/telegram.js`(알림), `server/README.md`.
- 유저스크립트: `src/core/remote.js`(폴링 어댑터), `src/core/config.js`(원격 설정 키), `src/core/queue.js`(다중 시리즈 큐), `src/core/downloader.js`(`tokiDownload`).
- 빌드: `npm run build:core` → `docs/tokiSync.user.js`.

## 부록 B — 비고
- sbxh 안티-탐지 수정 이력(읽기 정상화)은 커밋 `1da1ed5`/`cc5ffb5`/`8f245ba` 참조
  (attachShadow Proxy 전역설치가 광고-ack 차단의 원인이었고 워커 전용→기본 OFF로 해결).
- 다운로드 자체는 정상 동작 확인됨(워커 광고-ack는 정상 크기/세션에서 통과).
