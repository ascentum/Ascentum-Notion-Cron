import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-alert-"));
  Object.assign(process.env, { SQLITE_DB_PATH: path.join(dir, "test.sqlite"), INTERNAL_ADMIN_TOKEN: "fixture",
    DISCORD_CHANNEL_ID: "fixture", NOTION_USER_YOUNGMIN: "fixture", GCS_API_TOKEN_YOUNGMIN: "fixture" });
  const db = require("../src/database") as typeof import("../src/database");
  try {
    const { notifyReflectionFailure } = require("../src/services/reflection-alert-service");
    assert.equal(typeof notifyReflectionFailure, "function");
    const sent: string[] = [];
    const send = async (_channel: string, text: string) => { sent.push(text); return "message"; };
    const now = new Date("2026-10-22T00:00:00Z");
    assert.equal(await notifyReflectionFailure("2026-10-21", now, send), true);
    assert.equal(await notifyReflectionFailure("2026-10-21", new Date(now.getTime() + 60_000), send), false);
    db.closeDatabase();
    assert.equal(await notifyReflectionFailure("2026-10-21", new Date(now.getTime() + 120_000), send), false);
    assert.equal(await notifyReflectionFailure("2026-10-21", new Date(now.getTime() + 6 * 3600_000), send), true);
    assert.equal(sent.length, 2);
    assert.ok(sent.every(s => s.includes("2026-10-21") && s.includes("저장 실패")));
    await assert.rejects(notifyReflectionFailure("2026-10-20", now, async () => { throw new Error("send failed"); }));
    assert.equal(await notifyReflectionFailure("2026-10-20", now, send), true, "failed delivery must be retried");
    const { sendReflectionAlert } = require("../src/services/reflection-alert-service");
    assert.equal(typeof sendReflectionAlert, "function", "alert transport must have a bounded timeout");
    const originalFetch = global.fetch;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      global.fetch = (async (_url, init) => new Promise((_resolve, reject) => {
        assert.ok(init?.signal);
        init.signal.addEventListener("abort", () => reject(new Error("alert timeout")), { once: true });
      })) as typeof fetch;
      await assert.rejects(sendReflectionAlert("channel", "test", 10), /alert timeout/);
    } finally { global.fetch = originalFetch; clearTimeout(keepAlive); }
    console.log("reflection alert tests passed");
  } finally { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
