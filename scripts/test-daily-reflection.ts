import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompletionSource, Person, SnippetType } from "../src/types";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-reflection-"));
  Object.assign(process.env, {
    SQLITE_DB_PATH: path.join(dir, "test.sqlite"), INTERNAL_ADMIN_TOKEN: "fixture",
    DISCORD_CHANNEL_ID: "fixture", NOTION_USER_YOUNGMIN: "fixture",
    GCS_API_TOKEN_YOUNGMIN: "fixture", NOTION_API_KEY: "fixture",
    NOTION_REFLECTION_DATA_SOURCE_ID: "reflection-source",
  });
  const db = require("../src/database") as typeof import("../src/database");
  let service: any;
  try { service = require("../src/services/daily-reflection-service"); } catch (error: any) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  assert.equal(typeof service?.runDailyReflection, "function", "daily reflection service must exist");
  const { runDailyReflection, getDailyReflectionSchedule, formatReflectionTitle, extractReflection } = service;
  const now = new Date("2026-10-15T00:00:00Z");
  const content = "**오늘 한 일**\n업무\n\n**오늘의 배움 또는 남길 말**\n첫 번째 문단.\n같은 문단의 두 번째 줄.\n\n두 번째 문단.\n\n**헬스 체크 (10점)**\n5";
  const reflection = "첫 번째 문단.\n같은 문단의 두 번째 줄.\n\n두 번째 문단.";
  let sequence = 0;
  const add = (source: CompletionSource, options: {
    dateLabel?: string; createdAt?: string; content?: string; type?: SnippetType; person?: Person;
  } = {}) => {
    const id = `message-${++sequence}`;
    db.createDispatch({ discordMessageId: id, person: options.person ?? "youngmin",
      snippetType: options.type ?? "daily", dateLabel: options.dateLabel ?? "10/14",
      content: options.content ?? content, createdAt: options.createdAt ?? "2026-10-14T15:00:00Z",
      dueAt: "2026-10-14T15:30:00Z" });
    db.markDispatchPosted(id, { content: options.content ?? content, healthScore: 5,
      completionSource: source, postedAt: options.createdAt ?? "2026-10-14T15:10:00Z" });
    return id;
  };
  let pages: any[] = [], blocks = new Map<string, any[]>(), creates = 0, loseResponse = false;
  let queryCalls = 0;
  let expectedBody = reflection;
  const text = (value: string) => [{ type: "text", text: { content: value }, plain_text: value }];
  const page = (id: string, date: string, body: string) => {
    const p = { id, properties: { "이름": { type: "title", title: text(formatReflectionTitle(date)) },
      "날짜": { type: "date", date: { start: date, end: null, time_zone: null } } } };
    blocks.set(id, body.split("\n\n").map(s => ({ type: "paragraph", paragraph: { rich_text: text(s) } })));
    return p;
  };
  const client = {
    dataSources: { query: async (input: any) => {
      queryCalls++;
      assert.equal(input.data_source_id, "reflection-source");
      assert.deepEqual(input.filter, { property: "날짜", date: { equals: "2026-10-14" } });
      // Even a nonempty cursor page must be followed, without assuming one page.
      if (!input.start_cursor) return { results: [], has_more: true, next_cursor: "page-2" };
      return { results: pages, has_more: false, next_cursor: null };
    } },
    pages: {
      retrieve: async ({ page_id }: any) => pages.find(p => p.id === page_id),
      create: async (input: any) => {
        creates++;
        assert.deepEqual(input.parent, { type: "data_source_id", data_source_id: "reflection-source" });
        assert.ok(input.children.every((b: any) => b.paragraph.rich_text.every((t: any) => t.text.content.length <= 2000)));
        assert.equal(input.properties["이름"].title[0].text.content, "20261014(수)");
        assert.deepEqual(input.properties["날짜"].date, { start: "2026-10-14" });
        assert.equal(input.children.map((b: any) => b.paragraph.rich_text.map((t: any) => t.text.content).join("")).join("\n\n"), expectedBody);
        const p = page("new-page", "2026-10-14", expectedBody); pages.push(p);
        if (loseResponse) throw new Error("fixture response lost");
        return p;
      },
    },
    blocks: { children: { list: async ({ block_id, start_cursor }: any) => {
      const list = blocks.get(block_id) ?? [];
      return start_cursor ? { results: list.slice(1), has_more: false, next_cursor: null }
        : { results: list.slice(0, 1), has_more: list.length > 1, next_cursor: list.length > 1 ? "more" : null };
    } } },
  };
  const reset = () => {
    db.getDatabase().exec("DELETE FROM snippet_dispatches; DELETE FROM scheduler_state;");
    pages = []; blocks.clear(); creates = 0; loseResponse = false; queryCalls = 0; expectedBody = reflection;
  };
  try {
    assert.deepEqual(getDailyReflectionSchedule(new Date("2026-10-14T23:59:59Z")),
      { triggerDate: "2026-10-15", targetDate: "2026-10-14", due: false });
    assert.deepEqual(getDailyReflectionSchedule(now),
      { triggerDate: "2026-10-15", targetDate: "2026-10-14", due: true });
    assert.equal(getDailyReflectionSchedule(new Date("2026-01-01T00:00:00Z")).targetDate, "2025-12-31");
    assert.equal(formatReflectionTitle("2026-10-15"), "20261015(목)");
    assert.equal(formatReflectionTitle("2026-09-20"), "20260920(일)");
    assert.equal(extractReflection(content), reflection);
    assert.equal(extractReflection("**오늘의 배움 또는 남길 말**\n회고\n\n헬스 체크 (10점)\n5"), "회고");
    assert.equal(extractReflection("오늘 한 일만 있음"), null);
    assert.equal(extractReflection("**오늘의 배움 또는 남길 말**\n**개인적으로 중요한 배움**\n이 문장도 남겨야 한다.\n\n## 스스로의 다짐\n계속 시도하자."),
      "**개인적으로 중요한 배움**\n이 문장도 남겨야 한다.\n\n## 스스로의 다짐\n계속 시도하자.", "headings inside a reflection must not truncate its content");
    assert.equal(extractReflection("**오늘의 배움 또는 남길 말**\n  "), null);
    for (const source of ["auto", "manual-post", "manual-health", "manual-skip"] as const) add(source);
    add("manual-edit", { type: "weekly" });
    add("manual-edit", { createdAt: "2025-10-14T15:00:00Z" });
    add("manual-edit", { dateLabel: "10/13" });
    add("manual-edit", { createdAt: "2026-10-15T15:00:00Z" });
    assert.equal((await runDailyReflection(now, { client })).status, "skipped");
    assert.equal(creates, 0);
    assert.equal(queryCalls, 0, "ignored sources must not call Notion");
    for (const status of ["pending", "posting", "failed", "skipped"]) {
      reset(); const id = add("manual-edit");
      db.getDatabase().prepare("UPDATE snippet_dispatches SET status = ? WHERE discord_message_id = ?").run(status, id);
      assert.equal((await runDailyReflection(now, { client })).status, "skipped");
      assert.equal(creates, 0);
    }
    reset(); const other = add("manual-edit");
    db.getDatabase().prepare("UPDATE snippet_dispatches SET person = ? WHERE discord_message_id = ?").run("other", other);
    assert.equal((await runDailyReflection(now, { client })).status, "skipped");
    reset(); add("manual-edit", { content: "**오늘의 배움 또는 남길 말**\n " });
    assert.equal((await runDailyReflection(now, { client })).status, "skipped");
    reset(); add("manual-edit");
    pages = [page("existing-1", "2026-10-14", reflection), page("existing-2", "2026-10-14", reflection)];
    await assert.rejects(runDailyReflection(now, { client }), /multiple/i);
    assert.equal(creates, 0);
    reset(); expectedBody = "긴".repeat(2500);
    add("manual-edit", { content: "**오늘의 배움 또는 남길 말**\n" + expectedBody });
    assert.equal((await runDailyReflection(now, { client })).status, "created");
    reset();
    const yearEnd = add("manual-edit", { dateLabel: "12/31", createdAt: "2025-12-31T15:01:00Z" });
    add("manual-edit", { dateLabel: "12/31", createdAt: "2024-12-31T15:01:00Z" });
    assert.deepEqual(db.listEditedDailyReflections("2025-12-31", "2026-01-01T00:00:00Z").map(d => d.discordMessageId), [yearEnd]);
    assert.equal(db.claimReflectionCreation("fixture-claim", now.toISOString()), true);
    assert.equal(db.claimReflectionCreation("fixture-claim", now.toISOString()), false);
    reset(); add("manual-edit");
    assert.equal((await runDailyReflection(new Date("2026-10-14T23:59:59Z"), { client })).status, "not-due");
    assert.equal(queryCalls, 0);
    assert.equal((await runDailyReflection(now, { client })).status, "created");
    assert.equal(creates, 1);
    assert.equal((await runDailyReflection(now, { client })).status, "existing");
    assert.equal(creates, 1, "retry must not duplicate a created page");
    assert.ok(queryCalls >= 4, "date query must paginate");
    reset(); add("manual-edit");
    pages = [page("existing", "2026-10-14", reflection)];
    assert.equal((await runDailyReflection(now, { client })).status, "existing");
    assert.equal(creates, 0);
    reset(); add("manual-edit");
    pages = [page("existing", "2026-10-14", "ユーザーが修正した内容")];
    await assert.rejects(runDailyReflection(now, { client }), /conflict/i);
    assert.equal(creates, 0, "preserve human edits");
    reset(); add("manual-edit"); add("manual-edit", { content: content.replace("첫 번째", "다른") });
    await assert.rejects(runDailyReflection(now, { client }), /multiple|conflict/i);
    assert.equal(creates, 0);
    reset(); add("manual-edit"); add("manual-edit");
    assert.equal((await runDailyReflection(now, { client })).status, "created", "identical duplicate source messages need one page");
    reset(); add("manual-edit"); loseResponse = true;
    await assert.rejects(runDailyReflection(now, { client }), /response lost/);
    loseResponse = false;
    assert.equal((await runDailyReflection(now, { client })).status, "existing", "lost response must reconcile by date");
    assert.equal(creates, 1);
    pages = [];
    await assert.rejects(runDailyReflection(now, { client }), /uncertain/i);
    assert.equal(creates, 1, "uncertain creation must never issue a second POST");
    reset(); add("manual-edit");
    assert.equal((await runDailyReflection(now, { client, dryRun: true })).status, "would-create");
    assert.equal(creates, 0);
    assert.equal(db.getDatabase().prepare("SELECT COUNT(*) AS n FROM scheduler_state").get()!.n, 0);
    const recoveryNow = new Date("2026-10-22T00:00:00Z");
    assert.equal((await runDailyReflection(recoveryNow, { targetDate: "2026-10-14", client })).status, "created");
    assert.equal((await runDailyReflection(recoveryNow, { targetDate: "2026-10-14", client })).status, "existing");
    assert.equal(creates, 1, "historical recovery must be idempotent");
    await assert.rejects(runDailyReflection(recoveryNow, { targetDate: "2026-02-30", client }), /valid past/);
    await assert.rejects(runDailyReflection(recoveryNow, { targetDate: "2026-10-22", client }), /valid past/);
    console.log("daily reflection tests passed");
  } finally { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
