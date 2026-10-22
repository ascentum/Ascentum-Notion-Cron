import { loadEnvironment } from "../src/load-env";
import { getKstDateInfo, shiftIsoDate } from "../lib/time";

export function recoveryDates(from: string, to: string, now = new Date()) {
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid recovery date");
  }
  if (from > to || to >= getKstDateInfo(now).isoDate) throw new Error("Recovery requires an ordered past date range");
  const dates: string[] = [];
  for (let date = from; date <= to; date = shiftIsoDate(date, 1)) {
    dates.push(date);
    if (dates.length > 366) throw new Error("Recovery range exceeds 366 days");
  }
  return dates;
}

async function main() {
  loadEnvironment();
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const testAlert = args.includes("--test-alert");
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (["--dry-run", "--test-alert"].includes(args[i])) continue;
    if (!["--from", "--to"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error(`Invalid recovery argument: ${args[i]}`);
    }
    values[args[i]] = args[++i];
  }
  const { config } = await import("../src/config");
  if (testAlert) {
    if (args.length !== 1) throw new Error("--test-alert cannot be combined with recovery arguments");
    const { getDiscordMessage } = await import("../lib/discord");
    const { sendReflectionAlert } = await import("../src/services/reflection-alert-service");
    const content = "✅ [검증용] 영민 회고 저장 실패 알림 연결 확인입니다. 실제 저장 장애 알림이 아닙니다.";
    const messageId = await sendReflectionAlert(config.reflectionAlertChannelId, content);
    const message = await getDiscordMessage(config.reflectionAlertChannelId, messageId);
    if (message.content !== content) throw new Error("Reflection alert readback mismatch");
    console.log(JSON.stringify({ alertTest: "verified", channelId: config.reflectionAlertChannelId, messageId }));
    return;
  }
  const now = new Date();
  const dates = recoveryDates(values["--from"] ?? "", values["--to"] ?? "", now);
  const { initializeDatabase, closeDatabase } = await import("../src/database");
  const { runDailyReflection } = await import("../src/services/daily-reflection-service");
  initializeDatabase(dryRun);
  let failed = 0;
  try {
    for (const targetDate of dates) {
      try { console.log(JSON.stringify(await runDailyReflection(now, { targetDate, dryRun }))); }
      catch (error) { failed++; console.error(JSON.stringify({ targetDate, status: "failed", error: String(error) })); }
    }
    if (failed) throw new Error(`${failed} reflection dates failed; successful dates are safe to rerun`);
  } finally { closeDatabase(); }
}

if (require.main === module) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
