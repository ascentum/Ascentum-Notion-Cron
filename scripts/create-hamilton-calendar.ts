import dotenv from "dotenv";
import { loadEnvironment } from "../src/load-env";

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let targetDate: string | undefined;
  let envPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--target-date" || args[i] === "--env") {
      const flag = args[i];
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--target-date") targetDate = value;
      else envPath = value;
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  loadEnvironment();
  if (envPath) {
    const result = dotenv.config({ path: envPath, override: true, quiet: true });
    if (result.error) throw result.error;
  }
  dryRun ||= process.env.DRY_RUN === "true" || process.env.NOTION_DRY_RUN === "true";
  const { runHamiltonCalendar } = await import("../src/services/hamilton-calendar-service");
  const { closeDatabase } = await import("../src/database");
  try {
    console.log(JSON.stringify(await runHamiltonCalendar(new Date(), { dryRun, targetDate }), null, 2));
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error("[hamilton-calendar] failed:", error);
  process.exitCode = 1;
});
