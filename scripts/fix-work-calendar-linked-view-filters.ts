import { runWorkCalendarFilterFix } from "../lib/work-calendar";

export * from "../lib/work-calendar";

if (require.main === module) {
  runWorkCalendarFilterFix().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
