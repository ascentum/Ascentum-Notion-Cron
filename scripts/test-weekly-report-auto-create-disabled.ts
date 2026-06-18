import assert from "node:assert/strict";

process.env.INTERNAL_ADMIN_TOKEN = "test-token";
process.env.DISCORD_CHANNEL_ID = "discord-channel";
process.env.NOTION_USER_YOUNGMIN = "youngmin-user";
process.env.NOTION_USER_SEYEON = "seyeon-user";
process.env.GCS_API_TOKEN_YOUNGMIN = "gcs-youngmin";
process.env.GCS_API_TOKEN_SEYEON = "gcs-seyeon";

const { loadEnvironment } = require("../src/load-env") as typeof import("../src/load-env");
loadEnvironment();
process.env.ENABLE_MEETING_PAGE_AUTO_CREATE = "false";

const notionLib = require("../lib/notion") as typeof import("../lib/notion");
const openaiLib = require("../lib/openai") as typeof import("../lib/openai");

let createMeetingPageCalled = false;
let generateSummaryCalled = false;

(notionLib as any).getWorkItems = async () => [
  {
    date: "2026-05-28",
    title: "주간 리포트 자동 생성 중단",
    category: "운영",
    users: ["youngmin-user"],
  },
];

(notionLib as any).findMeetingPageByDate = async () => null;
(notionLib as any).createMeetingPage = async () => {
  createMeetingPageCalled = true;
  return { id: "new-meeting-page" };
};
(notionLib as any).waitForTemplateBlocks = async () => {
  throw new Error("should not wait for template blocks when auto-create is disabled");
};
(notionLib as any).getPageTopBlocks = async () => {
  throw new Error("should not fetch page blocks when auto-create is disabled");
};

(openaiLib as any).generateWeeklySummary = async () => {
  generateSummaryCalled = true;
  return { overview: "요약", summarizedDaily: [] };
};

async function main() {
  const { runWeeklyReport } = await import("../src/services/weekly-report-service");

  const result = await runWeeklyReport(new Date("2026-06-04T00:00:00.000+09:00"));

  assert.deepEqual(result, {
    success: true,
    pageId: null,
    tasksProcessed: 1,
    skipped: true,
    reason: "meeting-page-auto-create-disabled",
  });
  assert.equal(createMeetingPageCalled, false);
  assert.equal(generateSummaryCalled, false);
}

main()
  .then(() => {
    console.log("weekly report auto-create disabled checks passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
