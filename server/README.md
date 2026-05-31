# tokiSync 원격 제어 컨트롤 API + 대시보드

웹 대시보드(폰/노트북)에서 tokiSync 유저스크립트의 다운로드 큐를 원격 제어하고
진행률을 모니터링한다. 캡차 감지 시 텔레그램으로 알림을 받는다.

- **zero-dependency** (순수 Node `http`). `npm install` 불필요.
- 외부 접속은 **VPN 내부망**을 전제로 한다(Cloudflare Tunnel 미사용).

## 구조

```
[대시보드(폰/노트북)] ──VPN──> [컨트롤 API 서버] <──폴링── [윈도우 tokiSync 유저스크립트]
                                     │ 캡차 감지 → 텔레그램
```

- 서버 = 원격 제어 평면(명령 로그 보관 + 상태 미러).
- 유저스크립트 = 실행 엔진(`GET /queue?since=<seq>` 폴링 → 명령 적용, `POST /progress` 보고).

## 빠른 시작

```bash
cd server
cp config.example.json config.json     # 토큰/텔레그램 설정 (config.json은 git 무시됨)
node control-api.js                     # 또는 npm start
```

기본 포트 `8787`. 대시보드: `http://<서버IP>:8787/`

### 설정 (config.json 또는 환경변수)

| 항목 | config.json | env | 기본값 |
|------|-------------|-----|--------|
| 포트 | `port` | `PORT` | 8787 |
| 바인드 호스트 | `host` | `HOST` | 0.0.0.0 |
| API 토큰 | `token` | `TOKI_API_TOKEN` | (빈값=오픈모드) |
| 온라인 판정 윈도우(ms) | `onlineWindowMs` | - | 30000 |
| 상태 파일 | `dataFile` | - | data/state.json |
| 텔레그램 봇 토큰 | `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | - |
| 텔레그램 chat id | `telegram.chatId` | `TELEGRAM_CHAT_ID` | - |
| 텔레그램 thread id | `telegram.threadId` | `TELEGRAM_THREAD_ID` | - |
| 텔레그램 스크립트 경로 | `telegram.scriptPath` | `TELEGRAM_SCRIPT` | - |

> **비밀값(봇 토큰)은 repo에 커밋하지 말 것.** env 또는 gitignore된 `config.json`으로 주입한다.
> 텔레그램은 (1) `botToken`+`chatId` 직접 호출 또는 (2) 기존 `telegram-noti.sh` 스크립트(`scriptPath`) 둘 중 하나로 동작한다.

## API

대시보드/유저스크립트 공통 (인증: `X-Toki-Token` 헤더 / `Authorization: Bearer` / `?token=`):

| 메서드 | 경로 | 용도 |
|--------|------|------|
| GET | `/api/health` | 헬스체크(인증 불필요) |
| GET | `/queue?since=<seq>` | 상태 스냅샷 + seq 이후 명령 증분 |
| POST | `/queue` `{urls}` | 시리즈 URL 추가 명령 |
| POST | `/queue/start` | 시작 명령 |
| POST | `/queue/stop` | 정지 명령 |
| POST | `/queue/clear` | 비우기 명령 |
| POST | `/queue/remove` `{url}` | 항목 제거 명령 |
| POST | `/progress` `{queue,running,progress}` | 유저스크립트 상태 미러 보고 |
| POST | `/captcha` `{message,url}` | 캡차 감지 보고 → 텔레그램 |

### 멀티-IP lease 모드 엔드포인트

작업을 **회차 단위(unit)** 로 펼쳐 여러 클라이언트(서로 다른 출구 IP)가 **겹치지 않게** 가져가는
work-stealing 분배. clientId가 있으면 lease 모드, 없으면 위의 레거시 단일 모드로 폴백(하위호환).

| 메서드 | 경로 | 용도 |
|--------|------|------|
| POST | `/jobs` `{series, urls[]}` | 회차 URL들을 `units` 풀에 enqueue(정규화 url 키로 **멱등**) |
| GET | `/lease?clientId=X&max=N` | pending unit 최대 N개를 **원자적으로** X에 임대(만료시각 부여) |
| POST | `/complete` `{clientId, results:[{id,ok}]}` | unit done/failed 처리(실패→pending 재투입, attempts++) |
| GET | `/clients` | 풀 요약(pending/leased/done/failed) + 클라이언트별 online/IP/진행 |
| GET | `/units?status=` | unit 목록(status 필터: pending/leased/done/failed) |
| POST | `/requeue` `{ids[]}` | stuck lease/failed unit 강제 pending 재투입(운영 버튼) |
| POST | `/progress` `{clientId, label, ip, current[], ...}` | clientId별 진행/생존 보고 + 보유 lease TTL 갱신 |
| POST | `/captcha` `{clientId, ...}` | 캡차 시 해당 클라 lease 즉시 격리 재투입 + 텔레그램 |

추가 설정(`config.json`): `leaseTtlMs`(기본 120000=2분, 만료 시 자동 재투입), `leaseMax`(`/lease` max 미지정 시 기본 배정 수, 기본 4).

## 멀티-IP 병렬 다운로드 운영 런북 (Surfshark 2-프로필)

한 PC에서 **원래 IP + VPN IP**를 동시에 써서 같은 작품을 겹침 없이 병렬 다운로드한다.
사이트의 광고-ack·dev-block·레이트리밋은 **IP 단위**라, 출구 IP가 다른 클라이언트 2개는
독립 버킷 → 실효 처리량 ~2배. (설계 상세: `documentation/MULTI_IP_DOWNLOAD_ORCHESTRATION.md`)

1. **서버 기동** — `cd server && node control-api.js`. `config.json`에 `token` 설정 권장.
   VPN 내부망에서 win-c가 `http://<서버IP>:8787` 접근 가능해야 함.
2. **Chrome 프로필 A (원래 IP)** — Surfshark 확장 **OFF**. Tampermonkey + tokiSync 설치 →
   🌐 원격 제어 설정: URL·토큰 입력, **클라이언트 ID=`A-direct`**, 활성화.
3. **Chrome 프로필 B (VPN IP)** — Surfshark **Chrome 확장 ON**(가능하면 Static/Dedicated IP —
   공용 IP는 차단 이력 가능). 동일 설정 + **클라이언트 ID=`B-vpn`**.
4. **IP 검증** — 각 프로필에서 외부 IP가 실제로 다른지 확인(대시보드 클라이언트 카드의 IP, 또는 api.ipify.org).
5. **작업 투입** — 대시보드 **작업 투입(멀티-IP 분배)** 패널에서 작품 라벨 + 회차 URL 목록 입력
   (또는 `{n}` 범위 템플릿으로 생성) → **작업 풀에 투입**(`POST /jobs`). 두 프로필이 `/lease`로
   겹치지 않는 회차를 가져가 동시 다운로드 → 같은 Drive에 서로 다른 파일로 업로드(충돌 없음).
6. **모니터링** — **멀티-IP 작업 풀** 패널: 풀 막대(완료/진행/대기/실패) + 클라이언트 카드(IP/online/보유 unit).
   캡차/차단 시 텔레그램에 어느 클라(IP)인지 명시되고 그 클라 lease만 격리 재투입(다른 클라는 계속).

### 동작 보장 / 엣지 케이스

- **중복 방지** — done unit은 재임대 안 됨. enqueue는 정규화 url 키로 멱등(같은 회차 두 번 투입해도 1개).
- **유실 방지** — lease TTL 만료(클라 죽음/오프라인) 또는 `/complete` 실패 → pending 재투입.
  attempts 상한(3회) 도달 시 `failed` 격리(무한 재투입 방지). `/requeue`로 수동 회수 가능.
- **원자성** — Node 단일스레드 + 동기 처리라 "pending 골라 leased 표시"가 자연히 원자적(락 불필요).
  한 unit은 동시에 한 클라이언트만 보유.
- **IP별 보수적 동시성** — 한 IP를 너무 두드리면 그 IP만 차단됨. 회차 동시 처리 수/WAF 지터는 보수적으로.
- **재시작 복원** — `units`는 디스크 영속(`data/state.json`), 클라이언트 리포트(`reports`)는 휘발성.
  재시작 후 leased unit은 TTL 경과 시 자동 pending 복귀(안전한 실패).

### curl 빠른 검증

```bash
H='-H Content-Type:application/json'                       # 토큰 쓰면 -H "X-Toki-Token: <tok>" 추가
curl -s $H -d '{"series":"데모","urls":["https://x/1","https://x/2","https://x/3"]}' localhost:8787/jobs
curl -s "localhost:8787/lease?clientId=A-direct&max=2"     # A가 2개 가져감
curl -s "localhost:8787/lease?clientId=B-vpn&max=2"        # B는 겹치지 않는 나머지
curl -s localhost:8787/clients                             # 풀 요약 + 클라별 상태
curl -s $H -d '{"clientId":"A-direct","results":[{"id":"u1","ok":true}]}' localhost:8787/complete
```

## 유저스크립트 쪽 설정

Tampermonkey 메뉴 → **🌐 원격 제어 설정**:
- 원격 제어 활성화 체크
- 컨트롤 API 주소(`http://<서버IP>:8787`)
- API 토큰(서버 `config.json`의 `token`과 동일)
- 폴링 주기(초)
- **클라이언트 ID** — 비우면 단일 모드(`/queue`), 값을 넣으면 멀티-IP lease 모드(예: `A-direct`/`B-vpn`)
- **동시 보유 작업 수**(lease max) — 한 클라가 동시에 보유할 unit 수(기본 2)

저장 시 페이지가 새로고침되며 폴링이 시작된다.

## systemd 서비스 예시 (LXC 전환 시)

```ini
[Unit]
Description=tokiSync control API
After=network.target

[Service]
WorkingDirectory=/opt/tokisync/server
ExecStart=/usr/bin/node control-api.js
Environment=TOKI_API_TOKEN=xxxxx
Environment=TELEGRAM_BOT_TOKEN=xxxxx
Environment=TELEGRAM_CHAT_ID=-100xxxxx
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 주의

- 완전 무인 운영의 최대 걸림돌은 Cloudflare 캡차 — 텔레그램 알림으로 사람이 원격 인지/해결.
- 헤드리스 브라우저는 캡차/팝업 때문에 어려울 수 있음 → 실제 GUI 세션 필요 가능성.
- VPN 내부 접속이라도 컨트롤 API에 토큰 인증을 두는 것을 권장.
