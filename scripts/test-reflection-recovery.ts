import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoveryDates } from "./recover-daily-reflections";

const now = new Date("2026-10-22T00:00:00Z");
assert.deepEqual(recoveryDates("2026-10-15", "2026-10-21", now),
  ["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
assert.deepEqual(recoveryDates("2025-12-31", "2026-01-01", now), ["2025-12-31", "2026-01-01"]);
for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-10-22", "2026-10-22"],
  ["2026-10-21", "2026-10-15"], ["2020-01-01", "2026-10-21"], ["bad", "2026-10-21"]]) {
  assert.throws(() => recoveryDates(from, to, now));
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-readonly-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
const db = require("../src/database") as typeof import("../src/database");
try {
  db.initializeDatabase(); db.closeDatabase();
  db.initializeDatabase(true);
  assert.throws(() => db.setSchedulerState("test", "value", now.toISOString()), /readonly/i);
  assert.equal(db.listEditedDailyReflections("2026-10-15", now.toISOString()).length, 0);
  console.log("reflection recovery range and read-only tests passed");
} finally { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); }
