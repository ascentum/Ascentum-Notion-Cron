# Ascentum Notion Cron

Notion + Discord + GCS Pulse 자동화 서버. 현재 운영 기준은 `Oracle Cloud VM + Docker Compose`다.

`node:sqlite`를 사용하므로 런타임은 `Node 24+`가 필요하다.

## 운영 구성

- Oracle Cloud: Express 서버, Discord interaction endpoint, 내부 scheduler, SQLite 상태 저장을 담당한다.
- Caddy: Oracle VM에서 HTTPS 인증서 발급/갱신과 reverse proxy를 담당한다.
- GitHub Actions: Notion 반복 템플릿으로 생성된 업무 캘린더 페이지의 링크드 DB 뷰 필터를 보정한다.
- Notion: 업무 DB, 업무 캘린더 DB, 미팅 기록 DB를 데이터 소스로 사용한다.
- Discord: 스니펫 확인/수정/건너뛰기 상호작용을 받는다.
- GCS Pulse: 게시된 데일리/주간 스니펫 피드백 채점을 받는다.

## 운영 상태

- `2026-05-17` 기준 Oracle `/healthz`가 `200 OK`로 응답하고, scheduler는 enabled 상태다.
- 프로덕션 URL은 `https://notion-cron.168.110.123.188.sslip.io` 이다.
- Discord `Interactions Endpoint URL`은 `https://notion-cron.168.110.123.188.sslip.io/discord-interact`로 전환됐다.
- Railway production deployment는 내려갔고, Railway Variables의 `ENABLE_SCHEDULER=false`가 설정돼 있다.
- Oracle A1 Flex 신규 VM은 `Out of host capacity`로 생성하지 못해, 기존 Always Free 후보 VM인 `archy-ops-cron`에서 운영한다.

## 자동화 흐름

### 1. 데일리/주간 스니펫

- Oracle scheduler가 KST 날짜 변경을 기준으로 매일 한 번 실행한다.
- 데일리 스니펫은 KST 기준 실행일의 전날 업무를 대상으로 한다.
- 완료된 업무를 Notion에서 읽고 사람별로 정리한 뒤 OpenAI로 스니펫을 생성한다.
- Discord 채널에 버튼 메시지를 보내고, 각 메시지는 SQLite에 `pending` 상태로 저장된다.
- 30분 내 응답이 없으면 scheduler가 `due_at`이 지난 `pending` 레코드를 찾아 자동 게시한다.
- 월요일에는 지난 7일 범위의 주간 스니펫도 함께 생성한다.

### 2. Discord 상호작용

- `POST /discord-interact`가 Discord 버튼과 모달을 처리한다.
- 지원 동작은 `그대로 게시`, `헬스체크 입력`, `수정하기`, `건너뛰기`다.
- 게시 완료 후 GCS Pulse AI 채점(`/daily-snippets/feedback`, `/weekly-snippets/feedback`)을 비동기로 트리거한다.

### 3. 주간 미팅 리포트

- Oracle scheduler가 매주 목요일 KST 기준으로 주간 리포트를 생성한다.
- 레거시 업무 DB와 최신 업무 DB를 같이 조회해 Notion 미팅 기록 페이지를 채운다.
- `ENABLE_MEETING_PAGE_AUTO_CREATE=false`이면 해당 날짜의 `이민섭교수님` 미팅 페이지가 없을 때 새 페이지를 만들지 않고 스킵한다. 이미 만들어진 페이지가 있으면 기존처럼 내용을 채운다.

### 4. 업무 캘린더 링크드 뷰 필터 보정

- GitHub Actions가 KST 평일 03:00에 `사람`이 박영민 또는 Hamilton인 `어센텀 업무 ...` 캘린더 페이지를 스캔한다.
- 각 페이지의 첫 번째 콜아웃 안에 있는 `오늘의 업무` 테이블만 선택해 `완료일 = today` 필터를 해당 페이지의 `일정` 날짜로 바꾼다. 날짜 조건이 없으면 완료일 quick filter를 추가하고 담당자·카테고리 필터는 유지한다.
- 독립 보정과 Hamilton 생성 모두 같은 상단 테이블을 대상으로 한다. 아래 `Archy 업무` 등 다른 링크드뷰는 수정하지 않는다. 상단 대상 테이블이 없거나 여러 개면 임의 선택하지 않고 실패한다.
- 이미 날짜가 고정된 `완료일` 필터는 기본적으로 다시 바꾸지 않는다.
- 기본 스캔 범위는 KST 오늘 기준 2일 전부터 오늘까지다.
- 수동 실행은 GitHub Actions의 `Fix Notion linked view filters` workflow에서 `target_date`를 지정해 실행한다.

### Hamilton 업무 캘린더 전날 생성

- Oracle scheduler가 한국 시간 화~토 13시 이후 첫 tick에 다음 날 수~일 Hamilton 페이지를 생성한다. 재시작 시 같은 날 누락된 작업은 복구하며 이전 날짜는 일괄 생성하지 않는다.
- 기존 Hamilton 템플릿을 사용하고 제목은 `어센텀 업무 ` 뒤에 다음 업무일의 **Notion 날짜 멘션**을 넣고, `일정`은 다음 날, `사람`은 Hamilton으로 설정한다. 서버 API로 만든 멘션은 `@2026년 10월 9일`처럼 절대 날짜로 표시된다. 상대 날짜 형식은 공개 API가 지원하지 않아 사용자가 서버 날짜 멘션 방식을 선택했다. 일반 텍스트 날짜나 고정된 `@오늘` 문자열로 저장하지 않으며, 기존에 올바른 날짜 멘션이 있으면 제목을 재설정하지 않아 Notion에서 설정한 표시 형식을 유지한다.
- 템플릿 적용이 비동기이므로 뷰와 필터가 모두 준비될 때까지 기다린다. 생성 직후 잠시 빈 본문이나 `today` 필터가 보일 수 있다.
- 첫 번째 콜아웃의 `오늘의 업무` 테이블에서만 완료일을 다음 업무일로 고정한다. 템플릿에 날짜 조건이 없으면 해당 조건을 추가하며, 담당자·카테고리와 기존 필터 논리는 유지한다. 아래 `Archy 업무`는 템플릿의 상대 날짜 조건을 그대로 유지한다.
- 이미 같은 날짜 Hamilton 페이지가 있으면 재사용한다. 여러 개면 임의 수정하지 않고 실패한다. 같은 SQLite를 쓰는 CLI와 scheduler의 동시 실행도 날짜별 잠금으로 직렬화한다.
- `ENABLE_HAMILTON_CALENDAR_AUTO_CREATE=true`와 `HAMILTON_NOTION_REPEAT_DISABLED=true`가 모두 있어야 자동 생성이 활성화된다. **먼저 Notion의 Hamilton 템플릿 반복 생성을 해제하고 확인한다.** 기본은 비활성이다. 박영민 반복 생성 설정은 유지한다.
- 생성 요청의 응답 유실은 기존 페이지 조회로 복구한다. 생성 결과가 불확실하고 페이지가 조회되지 않으면 두 번째 생성 요청을 보내지 않고 오류를 기록한다. `/healthz`에서 `hamiltonCalendarEnabled` 및 최근 `scheduled-hamilton-calendar` 실행 기록을 확인한다.

수동 실행은 대상 날짜(수~일)를 명시한다. dry-run은 Notion과 SQLite를 수정하지 않는다. 실제 실행은 반복 생성 해제 확인값이 필요하다.

```bash
npm run notion:create-hamilton-calendar -- --dry-run --target-date 2026-10-08 --env ops/oracle/notion-cron.env
npm run notion:create-hamilton-calendar -- --target-date 2026-10-08 --env ops/oracle/notion-cron.env
```

Oracle 컨테이너에는 개발용 `tsx`가 없으므로 빌드된 CLI를 사용한다.

```bash
docker exec oracle-notion-cron-1 node dist/scripts/create-hamilton-calendar.js --dry-run --target-date 2026-10-08
```

응답 유실 후 `creation outcome is uncertain` 오류가 지속되면 먼저 Notion에서 해당 날짜 Hamilton 페이지의 존재 여부를 직접 확인한다. 페이지가 있으면 다음 실행의 조회로 복구한다. **페이지가 없음을 확인한 뒤에만** scheduler를 잠시 끄고 `calendar_page_runs`의 해당 날짜 `creation_requested=0`, `lock_owner=NULL`, `lock_until=NULL`로 초기화한다. 페이지가 존재할 가능성이 있는 상태에서 초기화하면 중복 생성될 수 있다.

### 5. 주간 업무 시간 리포트

- KST 월요일 00:00에 스케줄러가 지난주(월~일) 구글 캘린더 일정을 집계한다.
- 대상 캘린더는 `GOOGLE_CALENDAR_ID`로 지정된 `어센텀` 캘린더다. KST 2026-09-01 이전에는 제목에 `영민 근무`(또는 `WORK_HOURS_EVENT_KEYWORD` 설정값)가 포함된 **시간 지정 일정**만 근무로 인정하고, 2026-09-01부터는 제목과 관계없이 모든 시간 지정 일정을 박영민 업무 시간으로 집계한다. 종일 일정은 계속 제외한다.
- 날짜 경계를 넘는 일정은 KST 자정에서 나눠 날짜별 조건을 적용한다. 예를 들어 키워드가 없는 8월 31일 23:00~9월 1일 02:00 일정은 9월 1일의 2시간만 집계한다.
- 누적 평균은 별도 저장 없이 매번 캘린더에서 과거 기록을 다시 조회해 계산한다. 캘린더가 항상 단일 진실 소스라 과거 일정을 수정해도 평균이 자동 교정된다.
- 평균의 분모는 첫 근무 기록이 있는 주부터 지난주까지의 모든 주이며, 근무가 0시간인 주도 포함한다.
- 주차 표기(`N월 N째주`)는 그 주의 목요일이 속한 달을 기준으로 한다.
- 마지막 한 줄 멘트는 OpenAI가 매주 생성하고, 실패하면 성과 구간별 대체 멘트로 폴백한다.
- 결과는 Discord mgmt 채널(`1483333112686579774`)에 일반 텍스트로 전송된다.

## 환경변수

`.env.local` 또는 `ops/oracle/notion-cron.env`에 아래 값을 입력한다.

```env
PORT=3000
SQLITE_DB_PATH=./data/automation.sqlite
INTERNAL_ADMIN_TOKEN=
ENABLE_SCHEDULER=false
ENABLE_MEETING_PAGE_AUTO_CREATE=false
ENABLE_HAMILTON_CALENDAR_AUTO_CREATE=false
HAMILTON_NOTION_REPEAT_DISABLED=false
AUTO_POST_DELAY_MINUTES=30
SCHEDULER_TICK_SECONDS=60
APP_BASE_URL=

NOTION_API_KEY=
OPENAI_API_KEY=
NOTION_WORK_DB_ID=
NOTION_WORK_CALENDAR_DB_ID=
NOTION_WORK_CALENDAR_TITLE_PREFIX=어센텀 업무
NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME=일정
NOTION_HAMILTON_CALENDAR_TEMPLATE_ID=3f2bd55c-4778-8043-9ed0-d337f8b50734
NOTION_USER_HAMILTON=3f0d872b-594c-81a9-a34d-00024bd9314d
NOTION_WORK_CALENDAR_PERSON_PROPERTY_NAME=사람
# 박영민 보정 대상 ID. 미설정 시 NOTION_USER_YOUNGMIN으로 폴백한다. Hamilton도 함께 조회한다.
NOTION_WORK_CALENDAR_PERSON_ID=
NOTION_LINKED_VIEW_DATE_PROPERTY_NAME=완료일
NOTION_WORK_CALENDAR_LOOKBACK_DAYS=2
NOTION_LEGACY_WORK_DB_ID=
NOTION_WORK_DB_CUTOFF_DATE=2026-04-01
NOTION_MEETING_DB_ID=
NOTION_MEETING_DATA_SOURCE_ID=
NOTION_TEMPLATE_ID=
NOTION_USER_YOUNGMIN=

DISCORD_BOT_TOKEN=
DISCORD_APP_ID=
DISCORD_APP_PUBLIC_KEY=
DISCORD_CHANNEL_ID=

GCS_API_TOKEN_YOUNGMIN=
```

운영 기본값:

- Oracle production에서는 `ENABLE_SCHEDULER=true`
- Oracle production에서는 `ENABLE_MEETING_PAGE_AUTO_CREATE=false`
- Volume mount path는 `/app/data`
- Oracle production에서는 `SQLITE_DB_PATH=/app/data/automation.sqlite`
- Oracle VM host data path는 `/opt/notion-cron/data`
- `APP_BASE_URL=https://notion-cron.168.110.123.188.sslip.io`

## 로컬 실행

```bash
npm ci
cp .env.example .env.local
npm run dev
```

프로덕션 빌드:

```bash
npm run build
npm start
```

Discord slash command 등록:

```bash
npm run register:commands
```

업무 캘린더 링크드 뷰 필터 보정:

```bash
DRY_RUN=true npm run notion:fix-work-calendar-views
DRY_RUN=true TARGET_DATE=2026-05-16 npm run notion:fix-work-calendar-views
npm run notion:fix-work-calendar-views
```

GitHub Actions repository secrets:

- `NOTION_API_KEY`
- `NOTION_WORK_DB_ID`
- `NOTION_WORK_CALENDAR_DB_ID`

GitHub Actions repository variables는 선택값이다. 기본값과 다르게 운영할 때만 설정한다.

- `NOTION_WORK_CALENDAR_TITLE_PREFIX`
- `NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME`
- `NOTION_LINKED_VIEW_DATE_PROPERTY_NAME`
- `NOTION_WORK_CALENDAR_LOOKBACK_DAYS`

## 구글 캘린더 연동 (최초 1회)

1. GCP 프로젝트에서 **Google Calendar API**를 사용 설정한다. (프로젝트는 `ym5373@gachon.ac.kr` 계정 소유, OAuth 동의 화면 게시 상태는 `내부`)
2. OAuth 클라이언트를 만들고 `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`을 `.env.local`에 넣는다.
   현재 클라이언트는 **웹 애플리케이션** 유형이라 승인된 리디렉션 URI에 `http://localhost:5555/oauth2callback`가 등록되어 있어야 토큰 재발급이 된다. (데스크톱 앱 유형으로 만들면 루프백 URI가 자동 허용된다.)
3. 리프레시 토큰을 발급받는다. 출력된 URL을 브라우저에서 열고 `ym5373@gachon.ac.kr`로 동의하면 `.env.local`에 자동 저장된다.

```bash
npm run work-hours:oauth-setup
```

4. 발송 없이 집계만 확인한다.

```bash
npm run work-hours:send -- --dry-run --env ops/oracle/notion-cron.env
```

5. 실제 발송 (특정 주를 지정하려면 `--week <해당 주 월요일>`).

```bash
npm run work-hours:send -- --env ops/oracle/notion-cron.env
```

`GOOGLE_CALENDAR_ID`는 기본값이 `primary`이므로, `어센텀` 캘린더의 ID로 지정한다. `WORK_HOURS_EVENT_KEYWORD`는 KST 2026-09-01 이전 일정의 제목 필터에만 사용한다.

## 내부 엔드포인트

모든 `/internal/*` 엔드포인트는 `Authorization: Bearer $INTERNAL_ADMIN_TOKEN` 헤더가 필요하다.

- `POST /internal/snippets/send-daily`
- `POST /internal/snippets/sweep-timeouts`
- `POST /internal/reports/run-weekly`
- `POST /internal/reports/run-work-hours` (`{"dryRun":true}`, `{"targetWeekStart":"2026-08-31"}` 옵션)
- `POST /internal/snippets/retry/:id`
- `GET /healthz`

예시:

```bash
curl -X POST \
  -H "Authorization: Bearer $INTERNAL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"person":"youngmin","force":true}' \
  http://localhost:3000/internal/snippets/send-daily
```

## 테스트

```bash
npm run build
npm run test:task-hierarchy
npm run test:work-queries
npm run test:automation-state
npm run test:load-env
npm run test:work-calendar-view-filters
npm run test:hamilton-calendar
npm run test:hamilton-scheduler
npm run test:work-hours
```

## 장애 대응

- Oracle 상태 확인: `curl https://notion-cron.168.110.123.188.sslip.io/healthz`
- Oracle 컨테이너 확인: `ssh ubuntu@168.110.123.188 'cd /opt/notion-cron/app && docker compose --env-file ops/oracle/notion-cron.env -f ops/oracle/docker-compose.yml ps'`
- Discord interaction 장애: Discord application의 Interactions Endpoint URL이 `https://notion-cron.168.110.123.188.sslip.io/discord-interact`인지 확인한다.
- 데일리/주간 스니펫 누락: `/healthz`의 `recentJobs`와 Oracle Docker logs를 확인하고, 필요하면 `/internal/snippets/send-daily` 또는 `/internal/reports/run-weekly`를 내부 토큰으로 수동 호출한다.
- 업무 캘린더 링크드 뷰 필터 누락: GitHub Actions `Fix Notion linked view filters`를 `target_date=YYYY-MM-DD`로 수동 실행한다.
- Notion API 실패: 통합 토큰이 대상 DB와 생성된 페이지에 접근 권한이 있는지, `NOTION_WORK_DB_ID`/`NOTION_WORK_CALENDAR_DB_ID`가 맞는지 확인한다.

## 배포

### 자동 배포 (GitHub Actions)

- `Oracle Deploy` workflow를 `workflow_dispatch`로 실행한다. `confirm`에 `DISCOVER`를 넣으면 호스트 상태만 조회하고, `DEPLOY`를 넣어야 실제로 배포한다.
- `/opt/notion-cron/app`은 git 체크아웃이 아니라 **아티팩트 디렉터리**다. 그래서 배포는 `git pull`이 아니라 GitHub tarball을 받아 디렉터리를 통째로 교체한다. 레포가 public이라 호스트가 직접 받을 수 있고 별도 자격증명이 필요 없다.
- 교체 전 전체를 `~/notion-cron-backups/<타임스탬프>`에 백업하고, 레포에 없는 운영 자산인 `ops/oracle/notion-cron.env`는 새 아티팩트로 옮겨 심는다.
- 이 스택은 compose 파일 **두 개**(`ops/oracle/docker-compose.yml` + `/opt/archy-proxy/compose.override.yml`)로 떠 있다. 하나만 넘기면 caddy가 override 없이 재생성되어 프록시가 깨지므로, caddy 컨테이너 라벨의 파일 목록을 그대로 재사용하고 `notion-cron` 서비스만 빌드한다.
- 빌드 후 `/healthz`가 200이 될 때까지 기다린다. 200이 안 나오면 백업을 되돌리고 재빌드한 뒤 실패로 끝낸다.
- **이 workflow는 self-hosted runner에서만 돈다.** 외부에서는 호스트에 SSH로 들어갈 수 없기 때문이다. 22번이 NSG에서 사설 IP 두 개로만 열려 있고, NSG에 공인 IP를 추가해도 ufw가 따로 막는다. Oracle Cloud Agent의 Run Command 플러그인은 이 에이전트 버전에 없고, Bastion은 세션 인증까지는 통과하지만 대상 연결이 끊긴다. 같은 서브넷의 러너를 경유하는 것이 유일하게 동작하는 경로다.

필요한 레포 설정:

| 종류 | 이름 | 내용 |
| --- | --- | --- |
| Secret | `API_HOST` | 러너에서 접근 가능한 호스트 주소 (사설 IP) |
| Secret | `API_USER` | 배포 계정 |
| Secret | `API_SSH_PORT` | SSH 포트 |
| Secret | `API_SSH_KEY` | 배포용 SSH private key |
| Variable | `NOTION_CRON_APP_DIR` | 호스트 아티팩트 경로. 미설정 시 `/opt/notion-cron/app` |

self-hosted runner는 `notion-cron` 라벨로 이 레포에 등록되어 있어야 한다. 러너가 없으면 job이 큐에서 대기만 한다.

러너는 `archy-github-runner` VM에 올린다. 그 VM은 같은 VCN 안에 있어 배포 대상 호스트의 22번이 열려 있는 두 IP 중 하나다. 등록 관례는 `~/actions-runner-<이름>` 디렉터리에 받아 `svc.sh`로 systemd 서비스를 만드는 것이다. 같은 VM에 다른 레포용 러너가 이미 여러 개 떠 있다.

Hamilton 생성기를 처음 활성화할 때는 Notion 반복 해제를 확인한 후 `Oracle Deploy`의 `enable_hamilton_calendar=true`와 `hamilton_repeat_disabled_confirmed=true`를 함께 지정한다. 두 확인값은 배포 시 Oracle 환경 파일의 생성 활성화/반복 해제 확인값과 확인된 캘린더·Hamilton 템플릿·사람 ID에 반영된다. 서버를 시작하기 전에 scheduler를 끈 임시 컨테이너에서 다음 근무일 dry-run을 통과해야 활성화한다. 기존 환경은 백업되어 롤백 시 복구된다. 이후 일반 배포는 해당 값을 보존한다.

### 수동 배포

러너를 못 쓸 때는 허용된 경로에서 직접 실행한다.

```bash
APP=/opt/notion-cron/app
cd "$APP"
# 아티팩트 디렉터리라 git pull 이 아니다. 받아서 교체한다.
cp -a "$APP" ~/notion-cron-backups/$(date +%Y%m%d%H%M%S)
curl -fsSL https://github.com/ascentum/Ascentum-Notion-Cron/archive/refs/heads/main.tar.gz -o /tmp/nc.tar.gz
# notion-cron.env 는 레포에 없으니 반드시 보존할 것

# compose 파일 목록은 caddy 라벨에서 그대로 가져온다 (archy-proxy override 포함)
docker inspect oracle-caddy-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
docker compose -p oracle --env-file ops/oracle/notion-cron.env   -f ops/oracle/docker-compose.yml -f /opt/archy-proxy/compose.override.yml   up -d --build notion-cron
curl -fsS https://notion-cron.168.110.123.188.sslip.io/healthz
```

## 배포 메모

- Oracle VM: `archy-ops-cron`
- Oracle app path: `/opt/notion-cron/app`
- Oracle data path: `/opt/notion-cron/data/automation.sqlite`
- Oracle deploy: `Oracle Deploy` workflow (self-hosted runner 경유). 자세한 내용은 위 `## 배포` 참고
- Oracle app path는 git 체크아웃이 아니라 아티팩트 디렉터리다 (`.git` 없음)
- GitHub repository: `ascentum/Ascentum-Notion-Cron`
- Railway project name: `Ascentum Notion Cron`
- Railway service name: `notion-cron`
- Railway 설정은 rollback 참고용으로 `railway.toml`에 남겨둔다.
- 비용 0원 운영 제약 때문에 reserved public IP, load balancer, 유료 DNS는 사용하지 않는다. VM 재생성 시 public IP와 `sslip.io` hostname이 바뀔 수 있다.

## Discord Cutover 체크리스트

1. Discord application의 Interactions Endpoint URL이 `https://notion-cron.168.110.123.188.sslip.io/discord-interact`인지 확인한다.
2. `/snippet` slash command가 정상 응답하는지 확인한다.
3. 버튼 클릭, 수정, 헬스체크 입력, 건너뛰기가 모두 정상 동작하는지 확인한다.
4. 30분 미응답 자동 게시가 정상 동작하는지 확인한다.
5. 안정화 확인 후 Railway Hobby plan 구독을 해지한다.

## 프로젝트 구조

```text
src/
  server.ts                    # Express 엔트리포인트
  scheduler.ts                 # 1분 tick 스케줄러
  database.ts                  # SQLite 저장소
  discord-handler.ts           # Discord interaction 처리
  services/
    daily-snippet-service.ts   # 데일리/주간 스니펫 생성
    dispatch-service.ts        # pending/posted/skipped 상태 전이
    weekly-report-service.ts   # Notion 주간 리포트
    work-hours-service.ts      # 구글 캘린더 주간 업무 시간 리포트
lib/
  notion.ts
  openai.ts
  discord.ts
  gcs.ts
  google-calendar.ts           # OAuth 토큰 갱신 + 캘린더 조회
  work-hours.ts                # 근무 시간 집계/포맷 (순수 함수)
```
