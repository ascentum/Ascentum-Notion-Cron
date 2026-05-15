# Ascentum Notion Cron

Notion + Discord + GCS Pulse 자동화 서버. 현재 운영 기준은 `Railway 단일 서비스`다.

`node:sqlite`를 사용하므로 런타임은 `Node 24+`가 필요하다.

## 운영 구성

- Railway: Express 서버, Discord interaction endpoint, 내부 scheduler, SQLite 상태 저장을 담당한다.
- GitHub Actions: Notion 반복 템플릿으로 생성된 업무 캘린더 페이지의 링크드 DB 뷰 필터를 보정한다.
- Notion: 업무 DB, 업무 캘린더 DB, 미팅 기록 DB를 데이터 소스로 사용한다.
- Discord: 스니펫 확인/수정/건너뛰기 상호작용을 받는다.
- GCS Pulse: 게시된 데일리/주간 스니펫 피드백 채점을 받는다.

## 운영 상태

- `2026-05-16` 기준 `/healthz`가 `200 OK`로 응답하고, Railway scheduler는 enabled 상태다.
- GitHub `main`은 Railway 프로덕션에 자동 배포되는 상태다.
- 프로덕션 URL은 `https://notion-cron-production.up.railway.app` 이다.
- `2026-04-24` 기준 남아 있던 수동 cutover 작업은 `Discord Interactions Endpoint URL`을 Railway의 `/discord-interact`로 변경하는 것이었다.
- 위 전환 후 Discord 버튼, `/snippet`, 30분 자동 게시를 실운영에서 확인하면 Vercel 프로젝트는 제거해도 된다.

## 자동화 흐름

### 1. 데일리/주간 스니펫

- Railway always-on 서비스가 KST 날짜 변경을 기준으로 매일 한 번 실행한다.
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

- Railway scheduler가 매주 목요일 KST 기준으로 주간 리포트를 생성한다.
- 레거시 업무 DB와 최신 업무 DB를 같이 조회해 Notion 미팅 기록 페이지를 채운다.

### 4. 업무 캘린더 링크드 뷰 필터 보정

- GitHub Actions가 KST 평일 03:00에 `어센텀 업무 ...` 캘린더 페이지를 스캔한다.
- 각 페이지의 첫 번째 콜아웃 안에 있는 `어센텀 업무 DB` 링크드 뷰에서 `완료일 = today` 필터를 해당 페이지의 `일정` 날짜로 바꾼다.
- 콜아웃 밖의 링크드 DB 뷰는 건드리지 않는다.
- 이미 날짜가 고정된 `완료일` 필터는 기본적으로 다시 바꾸지 않는다.
- 기본 스캔 범위는 KST 오늘 기준 2일 전부터 오늘까지다.
- 수동 실행은 GitHub Actions의 `Fix Notion linked view filters` workflow에서 `target_date`를 지정해 실행한다.

## 환경변수

`.env.local` 또는 Railway Variables에 아래 값을 입력한다.

```env
PORT=3000
SQLITE_DB_PATH=./data/automation.sqlite
INTERNAL_ADMIN_TOKEN=
ENABLE_SCHEDULER=false
AUTO_POST_DELAY_MINUTES=30
SCHEDULER_TICK_SECONDS=60
APP_BASE_URL=

NOTION_API_KEY=
OPENAI_API_KEY=
NOTION_WORK_DB_ID=
NOTION_WORK_CALENDAR_DB_ID=
NOTION_WORK_CALENDAR_TITLE_PREFIX=어센텀 업무
NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME=일정
NOTION_LINKED_VIEW_DATE_PROPERTY_NAME=완료일
NOTION_WORK_CALENDAR_LOOKBACK_DAYS=2
NOTION_LEGACY_WORK_DB_ID=
NOTION_WORK_DB_CUTOFF_DATE=2026-04-01
NOTION_MEETING_DB_ID=
NOTION_MEETING_DATA_SOURCE_ID=
NOTION_TEMPLATE_ID=
NOTION_USER_YOUNGMIN=
NOTION_USER_SEYEON=

DISCORD_BOT_TOKEN=
DISCORD_APP_ID=
DISCORD_APP_PUBLIC_KEY=
DISCORD_CHANNEL_ID=

GCS_API_TOKEN_YOUNGMIN=
GCS_API_TOKEN_SEYEON=
```

운영 기본값:

- Railway production에서는 `ENABLE_SCHEDULER=true`
- Volume mount path는 `/app/data`
- Railway production에서는 `SQLITE_DB_PATH=/app/data/automation.sqlite`
- `APP_BASE_URL=https://notion-cron-production.up.railway.app`

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

## 내부 엔드포인트

모든 `/internal/*` 엔드포인트는 `Authorization: Bearer $INTERNAL_ADMIN_TOKEN` 헤더가 필요하다.

- `POST /internal/snippets/send-daily`
- `POST /internal/snippets/sweep-timeouts`
- `POST /internal/reports/run-weekly`
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
```

## 장애 대응

- Railway 상태 확인: `curl https://notion-cron-production.up.railway.app/healthz`
- Discord interaction 장애: Discord Developer Portal의 Interactions Endpoint URL이 `https://notion-cron-production.up.railway.app/discord-interact`인지 확인한다.
- 데일리/주간 스니펫 누락: `/healthz`의 `recentJobs`와 Railway logs를 확인하고, 필요하면 `/internal/snippets/send-daily` 또는 `/internal/reports/run-weekly`를 내부 토큰으로 수동 호출한다.
- 업무 캘린더 링크드 뷰 필터 누락: GitHub Actions `Fix Notion linked view filters`를 `target_date=YYYY-MM-DD`로 수동 실행한다.
- Notion API 실패: 통합 토큰이 대상 DB와 생성된 페이지에 접근 권한이 있는지, `NOTION_WORK_DB_ID`/`NOTION_WORK_CALENDAR_DB_ID`가 맞는지 확인한다.

## 배포 메모

- Railway project name: `Ascentum Notion Cron`
- Railway service name: `notion-cron`
- GitHub repository: `ascentum/Ascentum-Notion-Cron`
- Railway는 `main` 브랜치 기준 auto deploy로 동작한다.
- Railway deploy/runtime 설정은 루트의 `railway.toml`로 함께 관리한다.
- start command는 `node dist/src/server.js`로 직접 지정해, 롤링 배포 시 `npm run start`의 `SIGTERM` 오탐 알림을 줄인다.

## Discord Cutover 체크리스트

1. Discord Developer Portal에서 Interactions Endpoint URL을 `https://notion-cron-production.up.railway.app/discord-interact`로 변경한다.
2. `/snippet` slash command가 정상 응답하는지 확인한다.
3. 버튼 클릭, 수정, 헬스체크 입력, 건너뛰기가 모두 정상 동작하는지 확인한다.
4. 30분 미응답 자동 게시가 정상 동작하는지 확인한다.
5. 확인이 끝나면 Vercel Git 연결을 해제하고, 최종적으로 Vercel 프로젝트를 삭제한다.

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
lib/
  notion.ts
  openai.ts
  discord.ts
  gcs.ts
```
