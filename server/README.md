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

## 유저스크립트 쪽 설정

Tampermonkey 메뉴 → **🌐 원격 제어 설정**:
- 원격 제어 활성화 체크
- 컨트롤 API 주소(`http://<서버IP>:8787`)
- API 토큰(서버 `config.json`의 `token`과 동일)
- 폴링 주기(초)

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
