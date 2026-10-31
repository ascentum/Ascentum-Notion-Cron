import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";

const STATE_KEY = "last_hamilton_calendar_trigger_date";
const JOB_NAME = "scheduled-hamilton-calendar";

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hamilton-scheduler-"));
  const fixture = {
    SQLITE_DB_PATH: path.join(tempDir, "scheduler.sqlite"),
    INTERNAL_ADMIN_TOKEN: "fixture-admin-token",
    DISCORD_CHANNEL_ID: "fixture-channel",
    NOTION_USER_YOUNGMIN: "fixture-user",
    GCS_API_TOKEN_YOUNGMIN: "fixture-gcs-token",
    ENABLE_SCHEDULER: "true",
    ENABLE_MEETING_PAGE_AUTO_CREATE: "false",
    ENABLE_DAILY_REFLECTION_SYNC: "false",
    ENABLE_HAMILTON_CALENDAR_AUTO_CREATE: "true",
    HAMILTON_NOTION_REPEAT_DISABLED: "true",
    SCHEDULER_TICK_SECONDS: "60",
    PORT: "3000",
    AUTO_POST_DELAY_MINUTES: "30",
    WORK_HOURS_HISTORY_LOOKBACK_DAYS: "730",
    NOTION_API_KEY: "fixture-notion-token",
    NOTION_USER_HAMILTON: "retired-hamilton",
    NOTION_WORK_CALENDAR_DB_ID: "calendar-db",
    NOTION_WORK_DB_ID: "work-db",
    NOTION_WORK_CALENDAR_DATA_SOURCE_ID: "calendar-source",
    NOTION_WORK_DATA_SOURCE_ID: "work-source",
    NOTION_WORK_CALENDAR_PERSON_ID: "fixture-user",
    NOTION_LINKED_VIEW_DATE_PROPERTY_ID: "completion-date",

  };
  const originalEnv = Object.fromEntries(Object.keys(fixture).map((key) => [key, process.env[key]]));
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalFetch = global.fetch;
  const originalError = console.error;
  const replacedModules = new Map<string, NodeModule | undefined>();
  let db: typeof import("../src/database") | undefined;
  let active: ReturnType<typeof import("../src/scheduler").startScheduler> | undefined;

  const stub = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier);
    replacedModules.set(id, require.cache[id]);
    const module = new Module(id);
    module.filename = id;
    module.loaded = true;
    module.exports = exports;
    require.cache[id] = module;
  };

  try {
    Object.assign(process.env, fixture);
    // Never read the project's .env/.env.local or call a real remote service.
    stub("../src/load-env", { loadEnvironment() {} });
    global.fetch = async () => { throw new Error("Unexpected network request in scheduler test"); };
    const config = { ...require("../src/config").config };
    stub("../src/config", { config });
    let sweeps = 0;
    const otherCalls: Date[] = [];
    stub("../src/services/dispatch-service", {
      async sweepDueDispatches() {
        sweeps++;
      },
    });
    for (const [specifier, exportName] of [
      ["../src/services/daily-snippet-service", "sendDailySnippets"],
      ["../src/services/weekly-report-service", "runWeeklyReport"],
      ["../src/services/work-hours-service", "runWorkHoursReport"],
    ]) {
      stub(specifier, { [exportName]: async (now: Date) => { otherCalls.push(now); } });
    }

    let capturedTick: (() => void) | undefined;
    const intervalHandle = {} as ReturnType<typeof setInterval>;
    let clearCount = 0;
    global.setInterval = ((callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 60_000);
      capturedTick = callback;
      return intervalHandle;
    }) as typeof setInterval;
    global.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      assert.equal(handle, intervalHandle);
      clearCount++;
      capturedTick = undefined;
    }) as typeof clearInterval;
    const errors: unknown[][] = [];
    console.error = (...args) => { errors.push(args); };

    db = require("../src/database") as typeof import("../src/database");
    const { startScheduler } = require("../src/scheduler") as typeof import("../src/scheduler");
    let now = new Date("2026-10-06T04:00:00Z"); // Tuesday 13:00 KST.
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const jobs = () => db!.listJobRuns(100).filter((job) => job.jobName === JOB_NAME);
    const marker = () => db!.getSchedulerState(STATE_KEY);
    const start = () => { active = startScheduler(() => now); };
    const tick = async () => {
      assert.ok(capturedTick);
      capturedTick();
      await settle();
    };
    const stop = () => { active!.stop(); active = undefined; };
    start();
    await settle();
    await tick();
    assert.equal(marker(), null);
    assert.equal(jobs().length, 0, "legacy activation flags must not schedule Hamilton");
    assert.equal(sweeps, 2, "existing dispatch sweep must continue");
    now = new Date("2026-10-07T04:00:00Z");
    await tick();
    assert.equal(otherCalls.length, 1, "daily snippets must continue after retirement");
    now = new Date("2026-10-08T04:00:00Z");
    await tick();
    assert.equal(otherCalls.length, 3, "Thursday must run daily snippets and weekly report");
    now = new Date("2026-10-12T04:00:00Z");
    await tick();
    assert.equal(otherCalls.length, 5, "Monday must run daily snippets and work-hours report");
    assert.equal(jobs().length, 0);
    assert.equal(marker(), null);
    assert.equal(errors.some(entry => String(entry[0]).includes("[scheduler]")), false);
    stop();
    assert.ok(clearCount > 0);
    // Exercise the actual scheduled filter-fix entry point with legacy env present.
    let queries = 0;
    global.fetch = async (url, init) => {
      assert.equal(String(url), "https://api.notion.com/v1/data_sources/calendar-source/query");
      const body = JSON.parse(String(init?.body));
      assert.equal(JSON.stringify(body).includes("retired-hamilton"), false);
      assert.ok(JSON.stringify(body).includes('"contains":"fixture-user"'));
      queries++;
      return new Response(JSON.stringify({results: [], has_more: false}), {status: 200});
    };
    const {runWorkCalendarFilterFix} = require("../lib/work-calendar") as typeof import("../lib/work-calendar");
    await runWorkCalendarFilterFix();
    assert.equal(queries, 1);
    console.log("Hamilton retirement tests passed");
  } finally {
    active?.stop();
    db?.closeDatabase();
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.fetch = originalFetch;
    console.error = originalError;
    for (const [id, previous] of replacedModules) {
      if (previous) require.cache[id] = previous; else delete require.cache[id];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
