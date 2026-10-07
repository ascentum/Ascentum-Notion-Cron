import { getKstDateInfo } from "../lib/time";
import { config } from "./config";
import {
  createJobRun,
  finishJobRun,
  getSchedulerState,
  setSchedulerState,
} from "./database";
import { sendDailySnippets } from "./services/daily-snippet-service";
import { sweepDueDispatches } from "./services/dispatch-service";
import { runWeeklyReport } from "./services/weekly-report-service";
import { runWorkHoursReport } from "./services/work-hours-service";
import { getHamiltonCalendarSchedule, runHamiltonCalendar } from "./services/hamilton-calendar-service";

const DAILY_STATE_KEY = "last_daily_send_trigger_date";
const WEEKLY_STATE_KEY = "last_weekly_report_trigger_date";
const WORK_HOURS_STATE_KEY = "last_work_hours_report_trigger_date";
const HAMILTON_CALENDAR_STATE_KEY = "last_hamilton_calendar_trigger_date";

function bootstrapSchedulerState(now: Date) {
  const { isoDate } = getKstDateInfo(now);
  const timestamp = now.toISOString();

  if (!getSchedulerState(DAILY_STATE_KEY)) {
    setSchedulerState(DAILY_STATE_KEY, isoDate, timestamp);
  }

  if (!getSchedulerState(WEEKLY_STATE_KEY)) {
    setSchedulerState(WEEKLY_STATE_KEY, isoDate, timestamp);
  }

  if (!getSchedulerState(WORK_HOURS_STATE_KEY)) {
    setSchedulerState(WORK_HOURS_STATE_KEY, isoDate, timestamp);
  }
}

async function runTrackedJob<T>(
  jobName: string,
  scheduledFor: string,
  work: () => Promise<T>
) {
  const startedAt = new Date().toISOString();
  const jobRunId = createJobRun(jobName, scheduledFor, startedAt);

  try {
    const result = await work();
    finishJobRun(jobRunId, "success", new Date().toISOString());
    return result;
  } catch (error) {
    finishJobRun(jobRunId, "failed", new Date().toISOString(), String(error));
    throw error;
  }
}

export function startScheduler(nowProvider: () => Date = () => new Date()) {
  let stopped = false;
  let running = false;

  bootstrapSchedulerState(nowProvider());

  const tick = async () => {
    if (stopped || running) return;
    running = true;

    try {
      // This job has its own error boundary: a Discord/OpenAI failure must not
      // prevent tomorrow's calendar from being prepared (and vice versa).
      const calendarNow = nowProvider();
      const calendarSchedule = getHamiltonCalendarSchedule(calendarNow);
      if (config.enableHamiltonCalendarAutoCreate && config.hamiltonNotionRepeatDisabled &&
        calendarSchedule.due &&
        getSchedulerState(HAMILTON_CALENDAR_STATE_KEY) !== calendarSchedule.triggerDate) {
        try {
          await runTrackedJob("scheduled-hamilton-calendar", calendarSchedule.targetDate, async () => {
            const result = await runHamiltonCalendar(calendarNow);
            if (result.status === "created" || result.status === "repaired") {
              setSchedulerState(HAMILTON_CALENDAR_STATE_KEY, calendarSchedule.triggerDate, new Date().toISOString());
            }
            if (result.status !== "created" && result.status !== "repaired") {
              throw new Error(`Hamilton calendar did not complete: ${result.status}`);
            }
            return result;
          });
        } catch (error) {
          console.error("[scheduler] Hamilton calendar failed:", error);
        }
      }
      await sweepDueDispatches();

      const now = nowProvider();
      const { isoDate, weekday } = getKstDateInfo(now);

      if (getSchedulerState(DAILY_STATE_KEY) !== isoDate) {
        await runTrackedJob("scheduled-daily-snippets", isoDate, async () => {
          const result = await sendDailySnippets(now);
          setSchedulerState(DAILY_STATE_KEY, isoDate, new Date().toISOString());
          return result;
        });
      }

      if (weekday === 4 && getSchedulerState(WEEKLY_STATE_KEY) !== isoDate) {
        await runTrackedJob("scheduled-weekly-report", isoDate, async () => {
          const result = await runWeeklyReport(now);
          setSchedulerState(WEEKLY_STATE_KEY, isoDate, new Date().toISOString());
          return result;
        });
      }

      // 월요일 00:00 KST — 지난주 업무 시간 리포트
      if (weekday === 1 && getSchedulerState(WORK_HOURS_STATE_KEY) !== isoDate) {
        await runTrackedJob("scheduled-work-hours-report", isoDate, async () => {
          const result = await runWorkHoursReport(now);
          setSchedulerState(
            WORK_HOURS_STATE_KEY,
            isoDate,
            new Date().toISOString()
          );
          return result;
        });
      }
    } catch (error) {
      console.error("[scheduler] tick failed:", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const intervalId = setInterval(() => {
    void tick();
  }, config.schedulerTickSeconds * 1000);

  return {
    stop() {
      stopped = true;
      clearInterval(intervalId);
    },
  };
}
