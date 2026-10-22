import { sendDiscordText } from "../../lib/discord";
import { config } from "../config";
import { getSchedulerState, setSchedulerState } from "../database";

export function sendReflectionAlert(channel: string, text: string, timeoutMs = 15_000) {
  return sendDiscordText(channel, text, AbortSignal.timeout(timeoutMs));
}

export async function notifyReflectionFailure(targetDate: string, now = new Date(), send = sendReflectionAlert) {
  const key = `reflection_alert:${config.reflectionDatabaseId}:${targetDate}`;
  const lastSent = getSchedulerState(key);
  if (lastSent && now.getTime() - Date.parse(lastSent) < 6 * 60 * 60_000) return false;
  await send(config.reflectionAlertChannelId,
    `⚠️ 영민 회고 Notion 저장 실패\n업무일: ${targetDate}\n자동 재시도 중입니다. 날짜가 지나면 해당 날짜의 복구가 필요합니다.\n운영 로그의 scheduled-daily-reflection 오류를 확인해 주세요.`);
  setSchedulerState(key, now.toISOString(), now.toISOString());
  return true;
}
