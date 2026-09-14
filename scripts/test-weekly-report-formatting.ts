import assert from "node:assert/strict";

process.env.INTERNAL_ADMIN_TOKEN = "test-token";
process.env.DISCORD_CHANNEL_ID = "discord-channel";
process.env.NOTION_USER_YOUNGMIN = "youngmin-user";
process.env.GCS_API_TOKEN_YOUNGMIN = "gcs-youngmin";

const notionLib = require("../lib/notion") as typeof import("../lib/notion");
const openaiLib = require("../lib/openai") as typeof import("../lib/openai");

let appendedOverviewBlocks: any[] | null = null;

(notionLib as any).getWorkItems = async () => [
  {
    date: "2026-05-28",
    title: "로그인 오류 수정",
    category: "서비스",
    users: ["youngmin-user"],
  },
];

(openaiLib as any).generateWeeklySummary = async () => ({
  overview:
    "서비스 안정화 및 개발 개선: 개발 팀은 로그인 오류와 UI 기능을 개선함.\n" +
    "운영 및 인증 효율성 증대: 행정 업무와 인증 흐름을 정리함.\n" +
    "신규 프로젝트 추진과 시장 확장: AI 기반 프로젝트 확장을 준비함.",
  summarizedDaily: [],
});

(notionLib as any).findMeetingPageByDate = async () => ({ id: "meeting-page" });
(notionLib as any).getPageTopBlocks = async () => [
  {
    id: "work-heading",
    type: "heading_2",
    heading_2: { rich_text: [{ plain_text: "2️⃣ 업무 진행 현황" }] },
  },
];
(notionLib as any).appendContent = async (
  _pageId: string,
  blocks: any[],
  afterBlockId?: string
) => {
  if (afterBlockId === "work-heading") {
    appendedOverviewBlocks = blocks;
  }
  return [];
};

async function main() {
  const { runWeeklyReport, buildDailyBreakdownBlocks } = await import(
    "../src/services/weekly-report-service"
  );

  await runWeeklyReport(new Date("2026-06-04T00:00:00.000+09:00"));

  assert.ok(appendedOverviewBlocks, "expected overview blocks to be appended");
  const richText = appendedOverviewBlocks[0].paragraph.rich_text;

  assert.equal(richText[0].text.content, "서비스 안정화 및 개발 개선");
  assert.equal(richText[0].annotations.bold, true);
  assert.equal(
    richText[1].text.content,
    ": 개발 팀은 로그인 오류와 UI 기능을 개선함."
  );

  // 대상이 1명이라 column_list를 쓰면 안 된다 (Notion은 컬럼 2개 미만인 column_list를 거부한다).
  const breakdown = buildDailyBreakdownBlocks([
    { date: "2026-05-28", youngmin: "로그인 오류 수정" },
    { date: "2026-05-29", youngmin: "" },
  ]);

  assert.equal(
    breakdown.some((block: any) => block.type === "column_list"),
    false,
    "expected no column_list for a single-person report"
  );
  assert.equal(breakdown[0].type, "heading_3");
  assert.equal(breakdown[0].heading_3.rich_text[0].text.content, "박영민");
  assert.equal(breakdown[1].type, "divider");
  assert.equal(breakdown.length, 3, "expected the empty day to be dropped");
  assert.equal(breakdown[2].type, "bulleted_list_item");
  assert.equal(
    breakdown[2].bulleted_list_item.rich_text[0].text.content,
    "5/28 "
  );
  assert.equal(
    breakdown[2].bulleted_list_item.rich_text[1].text.content,
    "로그인 오류 수정"
  );
}

main()
  .then(() => {
    console.log("weekly report formatting checks passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
