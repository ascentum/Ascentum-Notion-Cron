import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { getKstDateInfo } from "../lib/time";

const workflow = fs.readFileSync(".github/workflows/oracle-deploy.yml", "utf8");
function stepScript(name: string) {
  const step = workflow.split(`      - name: ${name}\n`)[1].split("\n      - name:")[0];
  return step.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
}

const validation = stepScript("Validate inputs");
for (const [mode, date, valid] of [
  ["DISCOVER", "", true], ["DEPLOY", "", true],
  ["RECOVER", "2026-10-12", true], ["RECOVER", "", false],
  ["DISCOVER", "2026-10-12", false], ["DEPLOY", "2026-10-12", false],
  ["RECOVER", "2026-10-12';exit 0", false], ["INVALID", "", false],
] as const) {
  const result = spawnSync("bash", ["-c", validation], { env: {
    PATH: process.env.PATH, CONFIRM: mode, TARGET_REF: "main", DIAGNOSTIC_DATE: "",
    WORK_HOURS_RECOVERY_DATE: date,
  }});
  assert.equal(result.status === 0, valid, `${mode} / ${date}: ${result.stdout}`);
}
assert.match(workflow, /if: \$\{\{ inputs.confirm == 'RECOVER' && inputs.work_hours_recovery_date != '' \}\}/);

const source = stepScript("Recover failed work-hours report").split("<<'NODE'\n")[1].split("\nNODE")[0];
async function recoveryCheck(options: {
  statuses: string[]; date?: string; now?: string; sends?: number; fails?: boolean;
}) {
  const now = options.now ?? "2026-10-12T16:00:00Z";
  const date = options.date ?? "2026-10-12";
  let sends = 0, finished = 0, state = "2026-10-05", exit = 0, created = 0;
  class FixedDate extends Date {
    constructor(value?: string) { super(value ?? now); }
  }
  const modules: Record<string, unknown> = {
    "./dist/lib/time": { getKstDateInfo },
    "./dist/src/database": {
      initializeDatabase() {}, closeDatabase() {},
      createJobRun() { created++; return 1; }, finishJobRun() { finished++; },
      getSchedulerState() { return state; }, setSchedulerState(_key: string, value: string) { state = value; },
    },
    "./dist/src/services/work-hours-service": { async runWorkHoursReport(scheduled: Date) {
      assert.equal(getKstDateInfo(scheduled).isoDate, date);
      sends++;
      if (options.fails) throw new Error("Discord response lost");
      return { sent: true, messageId: "verified" };
    } },
    "node:sqlite": { DatabaseSync: class {
      prepare() { return { all: () => options.statuses.map(status => ({ status })) }; }
      close() {}
    } },
  };
  vm.runInNewContext(source, {
    require: (name: string) => { assert.ok(name in modules); return modules[name]; },
    process: { env: { RECOVERY_DATE: date, SQLITE_DB_PATH: "mock" }, exit: (code: number) => { exit = code; } },
    console: { log() {}, error() {} }, Date: FixedDate,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, options.sends ?? 0);
  if (sends && !options.fails) {
    assert.equal(state, date); assert.equal(finished, 1); assert.equal(exit, 0);
  } else {
    assert.equal(exit, 1); assert.equal(finished, 0); assert.equal(state, "2026-10-05");
  }
  if (options.fails) assert.equal(created, 1, "Uncertain send must retain its running record");
}

async function main() {
  await recoveryCheck({ statuses: ["failed"], sends: 1 });
  await recoveryCheck({ statuses: [] });
  await recoveryCheck({ statuses: ["failed", "success"] });
  await recoveryCheck({ statuses: ["failed", "running"] });
  await recoveryCheck({ statuses: ["failed"], date: "2026-10-11" });
  await recoveryCheck({ statuses: ["failed"], date: "2026-10-19" });
  await recoveryCheck({ statuses: ["failed"], date: "2026-02-30" });
  await recoveryCheck({ statuses: ["failed"], date: "2026-10-05", now: "2026-10-11T15:00:00Z" });
  await recoveryCheck({ statuses: ["failed"], sends: 1, fails: true });
  console.log("Oracle work-hours workflow checks passed (mode guards and 9 recovery scenarios)");
}
main().catch(error => { console.error(error); process.exit(1); });
