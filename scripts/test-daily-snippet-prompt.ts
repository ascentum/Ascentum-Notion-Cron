import assert from "node:assert/strict";
import { buildDailySnippetPrompt } from "../lib/openai";

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
assert.ok(prompt.includes("오늘 실제로 만진 것을 반드시 하나 이상 구체적으로 언급할 것"));
assert.ok(prompt.includes("~가 얼마나 중요한지 다시 깨달았습니다"));
assert.ok(prompt.includes("평서체(~였다, ~해야겠다)로 쓸 것. 존댓말 금지"));

// 업무 목록과 이름/날짜가 실제로 주입되는지
assert.ok(prompt.includes("박영민"));
assert.ok(prompt.includes("2026-09-13"));
assert.ok(prompt.includes("[Ascentum] 스니펫 양식 개편\n[Archy] 링크드뷰 필터 보정"));

console.log("daily snippet prompt checks passed");
