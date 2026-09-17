import assert from "node:assert/strict";
import * as openai from "../lib/openai";

const { buildDailySnippetPrompt } = openai;

const prompt = buildDailySnippetPrompt("박영민", "2026-09-13", [
  "[Ascentum] 스니펫 양식 개편",
  "[Archy] 링크드뷰 필터 보정",
]);

// 남는 섹션
for (const section of ["**오늘 한 일**", "**수행 목적**", "**오늘의 배움 또는 남길 말**"]) {
  assert.ok(prompt.includes(section), `expected prompt to keep ${section}`);
}

// 제거된 섹션
for (const section of [
  "하이라이트",
  "로우라이트",
  "내일의 우선순위",
  "오늘 내가 팀에 기여한 가치",
]) {
  assert.ok(!prompt.includes(section), `expected prompt to drop ${section}`);
}

// 회고 지침: 구체성 앵커와 금지 표현이 실제로 프롬프트에 들어가야 한다
// 길이 폭주 방지: 업무마다 한 문장씩 쓰면 6문장짜리 회고가 된다
assert.ok(prompt.includes("3문장을 넘기지 말 것"));
assert.ok(prompt.includes("문장 수를 채우려 하지 말 것"));
assert.ok(prompt.includes("업무마다 한 문장씩 쓰지 말 것"));
assert.ok(prompt.includes("가장 마음에 남은 것 하나만 골라서 쓸 것"));
assert.ok(prompt.includes("~가 얼마나 중요한지 다시 깨달았습니다"));
assert.ok(prompt.includes("평서체(~였다, ~해야겠다)로 쓸 것. 존댓말 금지"));

// 업무 목록과 이름/날짜가 실제로 주입되는지
assert.ok(prompt.includes("박영민"));
assert.ok(prompt.includes("2026-09-13"));
assert.ok(prompt.includes("[Ascentum] 스니펫 양식 개편\n[Archy] 링크드뷰 필터 보정"));

// 모델이 부모 업무만 반환해도 오늘 한 일에는 입력된 하위 업무를 모두 복원해야 한다.
const restoreDailyTaskSection = (openai as any).restoreDailyTaskSection;
assert.equal(typeof restoreDailyTaskSection, "function");

const repaired = restoreDailyTaskSection(
  `**오늘 한 일**
- [Archy] App 백엔드 수정
- [Archy] App UI 수정

**수행 목적**
- 앱 안정화

**오늘의 배움 또는 남길 말**
관계형 데이터 확인이 필요했다.`,
  [
    "[Archy] App 백엔드 수정",
    "  - [Archy] Apple 계정 로그인 시 정보 수집 방식 개선",
    "[Archy] App UI 수정",
    "  - [Archy] 온보딩, 홈 화면 UI/UX 수정",
  ]
);

assert.ok(
  repaired.includes(
    "  - [Archy] Apple 계정 로그인 시 정보 수집 방식 개선"
  )
);
assert.ok(
  repaired.includes("  - [Archy] 온보딩, 홈 화면 UI/UX 수정")
);
assert.ok(
  repaired.includes(
    "  - [Archy] 온보딩, 홈 화면 UI/UX 수정\n\n**수행 목적**"
  )
);

console.log("daily snippet prompt checks passed");
