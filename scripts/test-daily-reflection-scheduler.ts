import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-scheduler-"));
  Object.assign(process.env, { SQLITE_DB_PATH: path.join(dir, "scheduler.sqlite"),
    INTERNAL_ADMIN_TOKEN: "fixture", DISCORD_CHANNEL_ID: "fixture", NOTION_USER_YOUNGMIN: "fixture",
    GCS_API_TOKEN_YOUNGMIN: "fixture", ENABLE_DAILY_REFLECTION_SYNC: "true",
    ENABLE_HAMILTON_CALENDAR_AUTO_CREATE: "false" });
  const stub = (specifier: string, exports: unknown) => {
    const id = require.resolve(specifier); const m = new Module(id);
    m.filename = id; m.loaded = true; m.exports = exports; require.cache[id] = m;
  };
  stub("../src/load-env", { loadEnvironment() {} });
  const config = { ...require("../src/config").config };
  stub("../src/config", { config });
  const { getDailyReflectionSchedule } = require("../src/services/daily-reflection-service");
  const calls: Date[] = [];
  let alertCalls = 0;
  stub("../src/services/reflection-alert-service", { async notifyReflectionFailure(date: string) {
    assert.equal(date, "2026-10-14"); alertCalls++; throw new Error("fixture alert failure");
  } });
  let fail = false, sweepFails = true, dailyCalls = 0;
  stub("../src/services/daily-reflection-service", { getDailyReflectionSchedule,
    async runDailyReflection(now: Date) { calls.push(now); if (fail) throw new Error("fixture sync failure");
      return { status: "skipped", targetDate: getDailyReflectionSchedule(now).targetDate }; } });
  stub("../src/services/dispatch-service", { async sweepDueDispatches() { if (sweepFails) throw new Error("fixture sweep failure"); } });
  stub("../src/services/daily-snippet-service", { async sendDailySnippets() { dailyCalls++; } });
  stub("../src/services/weekly-report-service", { async runWeeklyReport() {} });
  stub("../src/services/work-hours-service", { async runWorkHoursReport() {} });
  const originalInterval = global.setInterval, originalClear = global.clearInterval, originalError = console.error;
  let tick: (() => void) | undefined;
  global.setInterval = ((callback: () => void) => { tick = callback; return {} as any; }) as typeof setInterval;
  global.clearInterval = (() => { tick = undefined; }) as typeof clearInterval;
  console.error = () => {};
  const db = require("../src/database") as typeof import("../src/database");
  const { startScheduler } = require("../src/scheduler") as typeof import("../src/scheduler");
  const key = "last_daily_reflection_trigger_date";
  let now = new Date("2026-10-14T23:59:59Z");
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  let active: ReturnType<typeof startScheduler> | undefined;
  const start = () => { active = startScheduler(() => now); };
  const stop = () => { active?.stop(); active = undefined; };
  const next = async () => { assert.ok(tick); tick(); await settle(); };
  try {
    start(); await settle();
    assert.equal(calls.length, 0, "08:59:59 KST must not run");
    assert.equal(db.getSchedulerState(key), null, "bootstrap must not suppress today's first 9am run");
    now = new Date("2026-10-15T00:00:00Z"); await next();
    assert.equal(calls.length, 1, "09:00 must run even when dispatch sweep fails");
    assert.equal(db.getSchedulerState(key), "2026-10-15");
    const job = db.listJobRuns(20).find(j => j.jobName === "scheduled-daily-reflection");
    assert.equal(job?.scheduledFor, "2026-10-14"); assert.equal(job?.status, "success");
    await next(); assert.equal(calls.length, 1, "completed/skipped day must run once");
    stop(); db.closeDatabase(); start(); await settle();
    assert.equal(calls.length, 1, "restart must retain success marker");
    stop(); db.getDatabase().exec("DELETE FROM scheduler_state; DELETE FROM job_runs;");
    fail = true; sweepFails = false; start(); await settle();
    assert.equal(calls.length, 2); assert.equal(db.getSchedulerState(key), null);
    assert.equal(alertCalls, 1, "failed sync must notify without blocking retries when alert fails");
    assert.equal(db.listJobRuns(20).find(j => j.jobName === "scheduled-daily-reflection")?.status, "failed");
    fail = false; await next(); assert.equal(calls.length, 3); assert.equal(db.getSchedulerState(key), "2026-10-15");
    now = new Date("2026-10-16T00:00:00Z"); await next();
    assert.equal(calls.length, 4, "next day must process the new previous date");
    assert.equal(dailyCalls, 1, "reflection job must not block existing daily job");
    stop(); db.getDatabase().exec("DELETE FROM scheduler_state; DELETE FROM job_runs;");
    now = new Date("2026-10-18T03:00:00Z"); start(); await settle();
    assert.equal(calls.length, 5, "Sunday restart after 9am must recover only current day's target");
    assert.equal(db.listJobRuns(20).filter(j => j.jobName === "scheduled-daily-reflection").length, 1);
    stop(); config.enableDailyReflectionSync = false;
    db.getDatabase().exec("DELETE FROM scheduler_state; DELETE FROM job_runs;");
    start(); await settle(); assert.equal(calls.length, 5, "disabled flag must prevent execution");
    console.log("daily reflection scheduler tests passed");
  } finally { stop(); db.closeDatabase(); global.setInterval = originalInterval;
    global.clearInterval = originalClear; console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
