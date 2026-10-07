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
    ENABLE_HAMILTON_CALENDAR_AUTO_CREATE: "true",
    HAMILTON_NOTION_REPEAT_DISABLED: "true",
    SCHEDULER_TICK_SECONDS: "60",
    PORT: "3000",
    AUTO_POST_DELAY_MINUTES: "30",
    WORK_HOURS_HISTORY_LOOKBACK_DAYS: "730",
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
    const { getHamiltonCalendarSchedule } = require("../src/services/hamilton-calendar-service") as
      typeof import("../src/services/hamilton-calendar-service");
    let outcome: "created" | "repaired" | "locked" | "fail" = "created";
    const calls: Date[] = [];
    let sweeps = 0;
    let sweepFails = true;
    const otherCalls: Date[] = [];
    stub("../src/services/hamilton-calendar-service", {
      getHamiltonCalendarSchedule,
      async runHamiltonCalendar(now: Date) {
        calls.push(now);
        if (outcome === "fail") throw new Error("fixture calendar failure");
        return { status: outcome, targetDate: getHamiltonCalendarSchedule(now).targetDate };
      },
    });
    stub("../src/services/dispatch-service", {
      async sweepDueDispatches() {
        sweeps++;
        if (sweepFails) throw new Error("fixture dispatch failure");
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
    const reset = () => {
      if (active) stop();
      db!.getDatabase().exec("DELETE FROM scheduler_state; DELETE FROM job_runs;");
      calls.length = 0;
      errors.length = 0;
      outcome = "created";
      config.enableHamiltonCalendarAutoCreate = true;
      config.hamiltonNotionRepeatDisabled = true;
    };

    start();
    assert.equal(marker(), null, "bootstrap must not mark Hamilton complete on first activation after 13:00");
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].toISOString(), now.toISOString());
    assert.equal(marker(), "2026-10-06");
    assert.equal(jobs()[0].status, "success");
    assert.equal(jobs()[0].scheduledFor, "2026-10-07");
    assert.equal(sweeps, 1);
    assert.ok(errors.some((entry) => String(entry[0]).includes("tick failed")));
    await tick();
    assert.equal(calls.length, 1, "successful day must not run twice");
    stop();
    db.closeDatabase(); // Reopen the real SQLite file to exercise persisted restart state.
    start();
    await settle();
    assert.equal(calls.length, 1, "restart must respect the persisted success marker");
    assert.equal(jobs().length, 1);

    reset();
    outcome = "fail";
    start();
    await settle();
    assert.equal(marker(), null);
    assert.equal(jobs()[0].status, "failed");
    assert.match(jobs()[0].error!, /fixture calendar failure/);
    outcome = "repaired";
    await tick();
    assert.equal(calls.length, 2, "failure must retry on next tick");
    assert.equal(marker(), "2026-10-06");
    assert.deepEqual(jobs().map((job) => job.status), ["success", "failed"]);

    reset();
    outcome = "locked";
    start();
    await settle();
    assert.equal(marker(), null);
    assert.equal(jobs()[0].status, "failed", "locked must never be recorded as successful");
    assert.match(jobs()[0].error!, /locked/);
    outcome = "created";
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(marker(), "2026-10-06");

    reset();
    now = new Date("2026-10-06T03:59:59Z");
    start();
    await settle();
    assert.equal(calls.length, 0, "12:59:59 KST must not run");
    assert.equal(marker(), null);
    now = new Date("2026-10-06T04:00:00Z");
    await tick();
    assert.equal(calls.length, 1, "13:00 KST must run after a pre-13:00 start");

    for (const date of ["2026-10-04", "2026-10-05"]) {
      reset();
      now = new Date(`${date}T04:00:00Z`);
      start();
      await settle();
      await tick();
      assert.equal(calls.length, 0, `${date} (Sunday/Monday) must not run`);
      assert.equal(marker(), null);
      assert.equal(jobs().length, 0);
    }

    for (const gate of ["enableHamiltonCalendarAutoCreate", "hamiltonNotionRepeatDisabled"] as const) {
      reset();
      now = new Date("2026-10-06T04:00:00Z");
      config[gate] = false;
      start();
      await settle();
      assert.equal(calls.length, 0, `${gate}=false must gate calendar execution`);
      assert.equal(marker(), null);
      assert.equal(jobs().length, 0);
    }

    // The injected clock must also drive the existing jobs after midnight.
    reset();
    sweepFails = false;
    now = new Date("2026-10-06T03:00:00Z");
    start();
    await settle();
    now = new Date("2026-10-07T03:00:00Z");
    await tick();
    assert.equal(otherCalls.length, 1);
    assert.equal(otherCalls[0].toISOString(), now.toISOString());
    stop();
    assert.ok(clearCount > 0, "stop must clear the captured timer");
    console.log("Hamilton scheduler tests passed");
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
