import {
  appendContent,
  createMeetingPage,
  deleteBlock,
  findHeadingInBlocks,
  findMeetingPageByDate,
  findToggleInBlocks,
  formatWorkItem,
  getPageTopBlocks,
  getWorkItems,
  notion,
  waitForTemplateBlocks,
} from "../../lib/notion";
import { generateWeeklySummary, SummarizedDay } from "../../lib/openai";
import { getKstDateInfo, getPreviousWeekDateRange } from "../../lib/time";
import { config } from "../config";

function toShortDate(isoDate: string) {
  const [, month, day] = isoDate.split("-");
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}`;
}

async function deleteEmptyParagraph(toggleBlockId: string) {
  const response = await notion.blocks.children.list({
    block_id: toggleBlockId,
    page_size: 100,
  });

  for (const block of response.results) {
    const current = block as any;
    if (current.type === "paragraph" && current.paragraph?.rich_text?.length === 0) {
      await deleteBlock(current.id);
      break;
    }
  }
}

function buildOverviewRichText(line: string) {
  const dashIndex = line.indexOf(" — ");
  const colonIndex = line.indexOf(":");
  const separatorIndex =
    dashIndex === -1
      ? colonIndex
      : colonIndex === -1
        ? dashIndex
        : Math.min(dashIndex, colonIndex);

  if (separatorIndex === -1) {
    return [{ type: "text", text: { content: line } }];
  }

  const title = line.slice(0, separatorIndex).trim();
  const rest = line.slice(separatorIndex);
  if (!title || !rest.trim()) {
    return [{ type: "text", text: { content: line } }];
  }

  return [
    {
      type: "text",
      text: { content: title },
      annotations: { bold: true },
    },
    { type: "text", text: { content: rest } },
  ];
}

function buildContentBlocks(overview: string, startShort: string, endShort: string): any[] {
  const overviewBlocks = overview
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: buildOverviewRichText(line),
      },
    }));

  return [
    ...overviewBlocks,
    {
      object: "block",
      type: "toggle",
      toggle: {
        rich_text: [
          {
            type: "text",
            text: { content: `데일리 업무 진행상황 (${startShort}~${endShort})` },
          },
        ],
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [] },
          },
        ],
      },
    },
  ];
}

// 데일리 진행상황 블록. 대상자가 1명이라 column_list를 쓰지 않는다.
// (Notion column_list는 컬럼이 2개 이상이어야 하므로 1인 구성에서는 생성 자체가 거부된다.)
export function buildDailyBreakdownBlocks(summarizedDaily: SummarizedDay[]): any[] {
  const byDate = new Map<string, string[]>();

  for (const summary of summarizedDaily) {
    if (!summary.youngmin) continue;
    const shortDate = toShortDate(summary.date);
    const entry = byDate.get(shortDate) ?? [];
    entry.push(summary.youngmin);
    byDate.set(shortDate, entry);
  }

  const bullets = [...byDate.entries()].map(([date, texts]) => ({
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "text",
          text: { content: `${date} ` },
          annotations: { bold: true },
        },
        {
          type: "text",
          text: { content: texts.join(" / ") },
        },
      ],
    },
  }));

  return [
    {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: [{ type: "text", text: { content: "박영민" } }],
      },
    },
    { object: "block", type: "divider", divider: {} },
    ...bullets,
  ];
}

export async function runWeeklyReport(now: Date = new Date()) {
  const { isoDate: todayIso } = getKstDateInfo(now);
  const { startIso, endIso } = getPreviousWeekDateRange(todayIso);
  const workItems = await getWorkItems(startIso, endIso);
  const byDate = new Map<string, { youngmin: string[]; all: string[] }>();

  for (const item of workItems) {
    const formatted = formatWorkItem(item);
    const entry = byDate.get(item.date) ?? {
      youngmin: [],
      all: [],
    };

    entry.all.push(formatted);
    if (item.users.includes(config.notionUserIds.youngmin)) entry.youngmin.push(formatted);
    byDate.set(item.date, entry);
  }

  const dailySummaries = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tasks]) => ({
      date,
      youngminTasks: tasks.youngmin,
      allTasks: tasks.all,
    }));

  const totalTasks = dailySummaries.reduce(
    (sum, summary) => sum + summary.allTasks.length,
    0
  );

  if (totalTasks === 0) {
    return { success: true, pageId: null, tasksProcessed: 0, skipped: true };
  }

  const existingPage = await findMeetingPageByDate(todayIso);
  let pageId: string;

  if (existingPage) {
    pageId = existingPage.id;
  } else {
    if (!config.enableMeetingPageAutoCreate) {
      return {
        success: true,
        pageId: null,
        tasksProcessed: totalTasks,
        skipped: true,
        reason: "meeting-page-auto-create-disabled",
      };
    }

    const newPage = await createMeetingPage("이민섭교수님 미팅", todayIso);
    pageId = newPage.id;
    await waitForTemplateBlocks(pageId);
  }

  const { overview, summarizedDaily } = await generateWeeklySummary(dailySummaries, {
    startDate: startIso,
    endDate: endIso,
  });

  const startShort = toShortDate(startIso);
  const endShort = toShortDate(endIso);
  const topBlocks = await getPageTopBlocks(pageId);
  const insertAfterBlockId = findHeadingInBlocks(topBlocks, "2️⃣");
  const appendedBlocks = insertAfterBlockId
    ? await appendContent(
        pageId,
        buildContentBlocks(overview, startShort, endShort),
        insertAfterBlockId
      )
    : await appendContent(pageId, buildContentBlocks(overview, startShort, endShort));

  const toggleBlockId = findToggleInBlocks(appendedBlocks);
  if (toggleBlockId) {
    await appendContent(toggleBlockId, buildDailyBreakdownBlocks(summarizedDaily));
    await deleteEmptyParagraph(toggleBlockId);
  }

  return {
    success: true,
    pageId,
    tasksProcessed: totalTasks,
    skipped: false,
  };
}
