# Hamilton 업무 캘린더 구현 계획

> 실행 방식: subagent-driven-development 스킬을 적용한다. 공통 모듈 작업을 위임하고 생성 및 스케줄러를 통합한 뒤 설계 준수와 코드 품질을 검토한다.

**목표:** 화~토 한국 시간 13시에 다음 날 Hamilton 페이지를 템플릿으로 생성하고 날짜 필터 보정까지 완료한다.
**구조:** 기존 필터 스크립트를 공통 모듈로 추출한다. 생성 서비스는 템플릿 검증·중복 조회·생성·템플릿 대기·전체 링크드뷰 보정·검증을 수행한다. Oracle scheduler 및 SQLite 상태로 재실행을 제어한다.
**기술:** TypeScript, Node 24, Notion REST API 2026-03-11, SQLite, 기존 Oracle Docker Compose.

## 1. 공통 필터 모듈
- [x] `lib/work-calendar.ts`로 기존 API 및 보정 함수를 추출하고 기존 CLI를 호환 유지한다.
- [x] `queryCalendarPages`에서 날짜 AND 담당자 OR 필터를 사용한다. 기존 단일 담당자 호출도 호환한다.
- [x] `listLinkedWorkViews`에 첫 콜아웃/전체 페이지 탐색을 제공한다. 업데이트는 기존 필터 구조와 다른 조건을 보존한다.
- [x] `scripts/test-work-calendar-view-filters.ts`에서 두 담당자 OR 및 빈 담당자 실패를 검증한다.
- 실행: `npm run test:work-calendar-view-filters` → checks passed.

## 2. 생성 서비스와 영속 상태
- [x] `src/services/hamilton-calendar-service.ts`에 한국 시간 화~토 13시 이후 판정 및 다음 날 계산을 구현한다.
  ```ts
  const {isoDate, weekday} = getKstDateInfo(now);
  const hour = new Date(now.getTime() + 9*60*60*1000).getUTCHours();
  const due = weekday >= 2 && weekday <= 6 && hour >= 13;
  const targetDate = shiftIsoDate(isoDate, 1);
  ```
- [x] 템플릿 사람 속성을 확인하고 대상 날짜 Hamilton 페이지를 조회한다. 1개는 재사용, 2개 이상은 실패한다.
- [x] 생성 요청 전에 SQLite에 요청 상태를 저장한다. 응답 유실 시 조회로만 복구하고 불명확한 요청을 다시 POST하지 않는다. 동시 프로세스/수동 실행도 SQLite claim으로 직렬화한다.
- [x] 페이지 ID를 영속 저장하고 제한 재시도로 템플릿의 예상 뷰들을 기다린다. 전체 페이지 업무 뷰의 today 날짜를 수정하고 재조회 검증한다.
- [x] `scripts/test-hamilton-calendar.ts`에서 시간·월말·연말·중복·템플릿 지연·부분 적용·재실행·응답 유실·동시 실행·dry-run을 가짜 Notion API와 임시 SQLite로 검증한다.
- 실행: `npm run test:hamilton-calendar` → checks passed.

## 3. 스케줄러 및 수동 실행
- [x] `src/config.ts`에 기본 비활성인 `ENABLE_HAMILTON_CALENDAR_AUTO_CREATE`와 반복 생성 해제 확인 게이트를 추가한다.
- [x] `src/scheduler.ts`에서 다른 잡 실패와 분리해 생성 잡을 실행한다. 성공 시만 당일 실행 상태를 저장하고 실패 시 후속 tick에서 복구한다. 새 잡은 시작 시 당일 완료로 초기화하지 않는다.
- [x] `scripts/create-hamilton-calendar.ts`와 package script를 추가한다. `--dry-run`, `--target-date`, `--env`를 제공한다. 수동 날짜도 수~일만 허용한다.
- [x] `/healthz`에 활성화 상태를 표시한다. 기존 보정 workflow는 두 사람 ID를 전달한다.

## 4. 문서·검증·전환
- [x] `.env.example`, `ops/oracle/notion-cron.env.example`, README 및 Oracle runbook에 두 게이트, ID, 수동 실행과 응답 유실 복구 절차를 기록한다.
- [x] `npm run build`, 필터·생성·영속 상태·기존 주간 리포트 테스트를 실행한다.
- [x] 실제 Notion 템플릿과 다음 날 대상 날짜에 dry-run을 실행한다.
- [x] Notion 반복 생성 해제를 확인할 때까지 자동 생성기를 비활성 상태로 유지한다. UI 확인이 불가능하면 이를 운영 전환의 남은 조건으로 명시한다.
- [x] 변경을 브랜치에 커밋하고 리뷰 가능한 PR을 만든다. 운영 배포 전 반복 생성 해제와 신규 환경 설정을 확인한다.

## 계획 자체 검토
- 모든 설계 요구사항은 위 작업에 포함된다. 본문 적용의 비동기 특성으로 원자적 생성은 보장하지 않지만 검증 완료 전에는 성공 기록을 남기지 않는다.
- Notion API가 생성 idempotency key를 제공하지 않는 경우 응답 유실은 조회로 복구하며 중복 위험이 있는 자동 재생성을 하지 않는다. 관리자는 실제 생성 여부를 확인한 뒤 불명확한 요청 상태를 해제할 수 있다.

## 구현 및 실제 검증 기록
- Notion UI에서 Hamilton의 수~일 08시 반복을 해제하고 비활성을 확인했다.
- 설계 준수 검토와 코드 품질 검토를 통과했다. 명시적 400/429 거절 후 재시도, 응답 유실, 잠금 소유권 변경 후 쓰기 차단을 추가 검증했다.
- 생성·scheduler·필터·영속 상태·기존 주간 리포트 회귀 테스트 및 TypeScript 빌드를 통과했다. workflow YAML과 쉘 구문도 검증했다.
- dry-run 후 2026-10-08 Hamilton 페이지를 수동 생성하고 속성 및 전체 업무 링크드뷰 필터를 재조회하여 검증했다. 첫 예약 실행은 같은 페이지를 재사용한다.
- 생성 페이지 ID: `3f2bd55c-4778-818f-8862-d975eb95d534`.

- Oracle 최종 배포: https://github.com/ascentum/Ascentum-Notion-Cron/actions/runs/37564213865 (성공).
- 서버 활성화 전 임시 컨테이너 dry-run에서 2026-10-08 기존 페이지를 확인했다. 배포 후 `/healthz`의 `ok`, `schedulerEnabled`, `hamiltonCalendarEnabled`가 모두 true임을 확인했다.
- 운영 배포는 확인된 캘린더·템플릿·사람 ID를 반영하고 기존 환경과 아티팩트를 백업했다. 실제 쓰기 이전 preflight 실패 시 원래 운영 환경으로 롤백한다.

## 2026-10-08 제목 형식 보정
- 생성 및 템플릿 적용 후 PATCH가 제목의 날짜를 일반 텍스트로 넣던 원인을 확인했다.
- 사용자 요청에 따라 제목을 텍스트 접두사와 대상 업무일의 실제 Notion 날짜 멘션으로 설정하도록 수정했다. 일정 및 링크드뷰 필터 날짜는 계속 같은 업무일을 가리킨다. 공개 API는 상대 날짜 형식 필드 `date_format`을 HTTP 400으로 거부한다. 사용자는 별도 브라우저 보정 대신 서버 날짜 멘션 사용을 선택했으며, 새 페이지는 `@2026년 10월 9일`처럼 절대 날짜로 표시된다.
- 날짜 멘션의 API 표시 문자열은 지역·날짜에 따라 달라질 수 있어 검증은 실제 멘션 유형과 `mention.date.start`를 확인한다.
- 생성 요청과 템플릿 적용 후 PATCH의 날짜 멘션 회귀 테스트를 먼저 실패시킨 뒤 구현을 수정하여 통과시켰다. 생성·scheduler·필터 테스트 및 빌드를 통과했다.
- 기존 2026-10-08 Hamilton 페이지의 제목도 날짜 멘션으로 보정하고 API 재조회로 확인했다. Notion UI에서 이 페이지의 날짜 형식을 상대 날짜로 설정하여 `어센텀 업무 @오늘` 표시와 내부 `date_format: relative`를 확인했다.
- 재실행 시 올바른 날짜 멘션을 재설정하지 않는 회귀 테스트를 먼저 실패시킨 뒤 통과시켜 기존 표시 형식이 지워지지 않도록 했다.
