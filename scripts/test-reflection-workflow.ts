import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workflow = fs.readFileSync(".github/workflows/oracle-deploy.yml", "utf8");
function stepScript(name: string) {
  return workflow.split(`      - name: ${name}\n`)[1].split("\n      - name:")[0]
    .split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");
}
const validation = stepScript("Validate inputs");
const env = { PATH: process.env.PATH, TARGET_REF: "main", DIAGNOSTIC_DATE: "", WORK_HOURS_RECOVERY_DATE: "",
  HAMILTON_ENABLE: "false", HAMILTON_REPEAT_DISABLED: "false", REFLECTION_FROM: "2026-10-15", REFLECTION_TO: "2026-10-21" };
for (const [mode, overrides, valid] of [
  ["REFLECTION_CHECK", {}, true], ["REFLECTION_RECOVER", {}, true],
  ["REFLECTION_RECOVER", { REFLECTION_TO: "2026-10-21';exit 0" }, false],
  ["REFLECTION_CHECK", { REFLECTION_FROM: "" }, false],
  ["REFLECTION_ALERT_TEST", { REFLECTION_FROM: "", REFLECTION_TO: "" }, true],
  ["REFLECTION_ALERT_TEST", {}, false],
  ["DEPLOY", { REFLECTION_FROM: "", REFLECTION_TO: "", REFLECTION_SOURCE_ID: "3fabd55c-4778-80bb-ac97-000b65c0fda9" }, true],
  ["DEPLOY", { REFLECTION_FROM: "", REFLECTION_TO: "", REFLECTION_SOURCE_ID: "a';exit 0" }, false],
] as const) {
  const result = spawnSync("bash", ["-c", validation], { env: { ...env, CONFIRM: mode, ...overrides } });
  assert.equal(result.status === 0, valid, `${mode}: ${result.stdout}`);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-workflow-"));
try {
  fs.writeFileSync(path.join(dir, "ssh"), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  for (const mode of ["REFLECTION_CHECK", "REFLECTION_RECOVER", "REFLECTION_ALERT_TEST"]) {
    const result = spawnSync("bash", ["-c", stepScript("Recover or check reflections")], { encoding: "utf8",
      env: { ...env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, API_HOST: "fixture", API_USER: "fixture", API_SSH_PORT: "22", CONFIRM: mode } });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.match(result.stdout, /dist\/scripts\/recover-daily-reflections.js/);
    assert.equal(result.stdout.includes("--dry-run"), mode === "REFLECTION_CHECK");
    assert.equal(result.stdout.includes("--test-alert"), mode === "REFLECTION_ALERT_TEST");
  }
  for (const name of ["Deploy", "Inspect reflection data sources", "Recover or check reflections"]) {
    const result = spawnSync("bash", ["-n"], { input: stepScript(name), encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
  const preflight = stepScript("Deploy").split('compose build notion-cron || { rollback; exit 1; }')[1]
    .split('# Preflight in a temporary container')[0];
  const streamed = spawnSync("bash", ["-se"], { encoding: "utf8", input:
    'compose() { cat >/dev/null; echo PREFLIGHT; }; rollback() { echo ROLLBACK; }; REFLECTION_SOURCE_ID=fixture\n' +
    preflight + '\necho SERVER_START_REACHED\n' });
  assert.equal(streamed.status, 0, streamed.stderr);
  assert.match(streamed.stdout, /SERVER_START_REACHED/, "Docker preflight must not consume streamed deployment script");
  console.log("reflection workflow mode, command and bash syntax tests passed");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
