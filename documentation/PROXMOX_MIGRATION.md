# 컨트롤 API → Proxmox LXC 마이그레이션 가이드

> 목적: 멀티-IP 컨트롤 API(대시보드+lease+NAS 업로드 릴레이+유저스크립트 자동업데이트 서빙)를
> robocom(개발 PC) 의존에서 분리해 **Proxmox LXC 컨테이너에서 상시 가동**한다.
> 새 호스트: **`192.168.0.135:8787`** (같은 LAN 대역 → win-c VPN·NAS 도달성 유지).

마이그 후 robocom은 **빌드 전용(dev)** 으로 강등된다. 컨테이너 하나가 API+대시보드+유저스크립트
파일(`../docs/tokiSync.user.js`)+`rules.json`을 전부 8787에서 서빙하므로 robocom 없이 자립한다.

---

## 0. 사전 확인 (의존성 정리)

| 항목 | 컨테이너 요구사항 |
|---|---|
| **런타임** | Node LTS만 있으면 됨 (control-api는 **zero-dep**, `npm install` 불필요) |
| **NAS 도달** | 릴레이 업로드 시 워커가 `webdavUrl/user/pass`를 meta로 동봉 → **컨테이너엔 NAS 자격증명 저장 불필요**, NAS 망 도달성만 필요 |
| **win-c 도달** | win-c 각 프로필이 `192.168.0.135:8787`로 폴링 → 같은 LAN/VPN 대역이면 OK |
| **인증** | robocom가 **open 모드(token 빈값)** 로 운영 중 → 컨테이너도 동일, **클라 토큰 재입력 불필요** |
| **텔레그램** | `telegram-noti.sh`가 컨테이너에 없음 → `config.json`의 `botToken`+`chatId` 직접 방식으로 전환(서버 코드가 이미 지원) |

배포 레이아웃(컨테이너):
```
/opt/tokisync/
├── server/      (control-api.js, lib/, public/, config.json, data/state.json)
└── docs/        (tokiSync.user.js, rules.json, index.html, assets/)
```
control-api.js는 `__dirname` 기준으로 `./config.json`, `./data/state.json`, `../docs/`를 읽는다.

---

## Phase A — LXC 컨테이너 생성 (Proxmox 호스트 셸)

```bash
# (필요 시) Debian 12 템플릿 다운로드
pveam update
pveam available | grep debian-12
pveam download local debian-12-standard_12.7-1_amd64.tar.zst   # 버전은 환경에 맞게

# 컨테이너 생성 (VMID/스토리지/브리지는 환경에 맞게 조정)
pct create 135 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname tokisync-api \
  --cores 2 --memory 1024 --swap 512 \
  --rootfs local-lvm:8 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.0.135/24,gw=192.168.0.1 \
  --nameserver 1.1.1.1 \
  --unprivileged 1 \
  --onboot 1

pct start 135
```
> 메모리: 릴레이가 업로드 청크를 메모리에 임시 버퍼링(완료/5분 후 폐기) → 1GB면 충분(동시 대량 업로드 많으면 2GB).

## Phase B — Node 설치 (컨테이너 내부)

```bash
pct enter 135        # 또는 SSH

apt update && apt install -y curl rsync
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v              # v22.x 확인
exit
```

## Phase C — 코드 배포 (robocom → 컨테이너)

robocom에서 `server/`와 `docs/`를 컨테이너로 복사한다.
**`config.json`은 robocom 것(scriptPath 텔레그램)을 덮어쓰면 안 되므로 제외**하고, 별도 준비본을 넣는다.

```bash
# robocom 셸에서
cd /home/robocom/project/tokiSync

# server/ 복사 (robocom config.json 제외, node_modules 제외)
rsync -av --exclude 'config.json' --exclude 'node_modules' \
  server/ root@192.168.0.135:/opt/tokisync/server/

# docs/ 복사 (유저스크립트 본체 + rules.json + 대시보드 정적)
rsync -av docs/ root@192.168.0.135:/opt/tokisync/docs/
```
> `server/data/state.json`(871K)도 함께 복사되어 **기존 작업 풀이 이관**된다. 새로 시작하려면
> 복사 후 컨테이너에서 `rm /opt/tokisync/server/data/state.json` (서버가 빈 상태로 재생성).

## Phase D — config.json 배치 (시크릿)

robocom의 토큰(open 모드라 빈 값) + 텔레그램 botToken/chatId로 전환된 config가 준비돼 있다.

```bash
# robocom 셸에서 (준비본 → 컨테이너)
scp /home/robocom/.claude/jobs/db3b0866/tmp/container-config.json \
  root@192.168.0.135:/opt/tokisync/server/config.json

# 컨테이너에서 권한 잠금
pct enter 135
chmod 600 /opt/tokisync/server/config.json
```
> ⚠️ job tmp 디렉토리는 세션 종료 시 정리될 수 있으니 **scp는 이번 세션 중에** 수행할 것.
> config.json은 git-ignore 대상이며 botToken을 담으므로 **절대 커밋 금지**.

## Phase E — systemd 서비스 등록 (컨테이너 내부)

```bash
# robocom → 컨테이너로 유닛 복사
scp /home/robocom/.claude/jobs/db3b0866/tmp/tokisync-control-api.service \
  root@192.168.0.135:/etc/systemd/system/tokisync-control-api.service

# 컨테이너에서
pct enter 135
systemctl daemon-reload
systemctl enable --now tokisync-control-api
systemctl status tokisync-control-api          # active (running) 확인
journalctl -u tokisync-control-api -f          # 로그 팔로우
```

## Phase F — 동작 검증 (컨테이너 내부 / robocom)

```bash
# 헬스체크 (auth:false = open 모드)
curl -s http://192.168.0.135:8787/api/health

# 유저스크립트 서빙 (자동업데이트 소스)
curl -sI http://192.168.0.135:8787/tokiSync.user.js | head
curl -s http://192.168.0.135:8787/tokiSync.user.js | grep -m1 '@version'   # -16 확인

# 대시보드
#   브라우저: http://192.168.0.135:8787/
```

## Phase G — 클라이언트(win-c) 전환

각 프로필에서:
1. Tampermonkey → 🌐 원격 제어 설정 → **컨트롤 API URL을 `http://192.168.0.135:8787`** 로 변경
   (open 모드라 토큰은 비움).
2. **유저스크립트 1회 수동 재설치**: 옛 설치본은 `@updateURL`이 robocom(`192.168.0.100`)을 가리켜
   자동 전환이 안 됨. 새 소스(`http://192.168.0.135:8787/tokiSync.user.js`)에서 1회 재설치하면
   이후부터는 새 IP 기준 자동 업데이트가 동작한다.

## Phase H — robocom 정리 (검증 통과 후)

```bash
# robocom 셸에서: 컨트롤 API 서비스 정지/비활성
systemctl --user stop tokisync-control-api
systemctl --user disable tokisync-control-api
# (선택) 8765 python 유저스크립트 서빙도 은퇴 가능 — @updateURL이 8787로 이전됨
# (선택) linger 유지 여부는 다른 user 서비스 의존성에 따라 결정
```
robocom는 이후 **빌드 전용**: 코드 변경 → `TOKI_UPDATE_BASE_URL=http://192.168.0.135:8787 npm run build:core`
→ 산출 `docs/tokiSync.user.js`를 컨테이너 `/opt/tokisync/docs/`로 rsync(서비스 재시작 불필요, 요청마다 파일 읽음).

---

## 코드 변경 요약 (이번 마이그레이션)

| 파일 | 변경 |
|---|---|
| `src/core/lan-custom-ui.js:51` | placeholder `192.168.0.100` → `192.168.0.135` |
| `package.json` | `components.script` `-15` → `-16` |
| `build/lan-custom.cjs` | (변경 없음) — `TOKI_UPDATE_BASE_URL` env로 빌드 시 주입 |
| `docs/tokiSync.user.js` | 재빌드 산출물(`@updateURL`/`@downloadURL` → 새 IP) |

> `src/core/remote.js:927` placeholder는 이미 generic(`192.168.0.x`)이라 변경 불필요.
