import { config } from "../config";
import { Client } from "@notionhq/client";
import { getKstDateInfo, shiftIsoDate } from "../../lib/time";
import { claimReflectionCreation, listEditedDailyReflections } from "../database";

export function getDailyReflectionSchedule(now: Date) {
  const { isoDate } = getKstDateInfo(now);
  const hour = new Date(now.getTime() + 9 * 60 * 60_000).getUTCHours();
  return { triggerDate: isoDate, targetDate: shiftIsoDate(isoDate, -1), due: hour >= 9 };
}

export function formatReflectionTitle(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${date.replaceAll("-", "")}(${["일", "월", "화", "수", "목", "금", "토"][day]})`;
}

export function extractReflection(content: string): string | null {
  const heading = /^\s*(?:#{1,6}\s*)?(?:\*\*)?오늘의 배움 또는 남길 말(?:\*\*)?\s*$/m.exec(content);
  if (!heading) return null;
  const rest = content.slice(heading.index + heading[0].length);
  // Only known snippet fields end the section. A personal subheading or a
  // standalone bold sentence is still part of the user's reflection.
  const next = /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:오늘 한 일|수행 목적|헬스 체크\s*\(10점\))(?:\*\*)?\s*$/m.exec(rest);
  const result = (next ? rest.slice(0, next.index) : rest).trim();
  return result || null;
}

type ReflectionClient = Pick<Client, "databases" | "pages" | "blocks">;
interface Options { client?: ReflectionClient; dryRun?: boolean }

async function pagesForDate(client: ReflectionClient, targetDate: string) {
  const pages = [];
  let cursor: string | undefined;
  do {
    const result = await client.databases.query({ database_id: config.reflectionDatabaseId,
      filter: { property: "날짜", date: { equals: targetDate } }, page_size: 100, start_cursor: cursor });
    pages.push(...result.results);
    cursor = result.has_more ? result.next_cursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}

async function verifyPage(client: ReflectionClient, id: string, targetDate: string, reflection: string) {
  const page = await client.pages.retrieve({ page_id: id });
  if (!("properties" in page)) throw new Error(`Reflection page is incomplete: ${id}`);
  const name = page.properties["이름"];
  const date = page.properties["날짜"];
  if (name?.type !== "title" || name.title.map(t => t.plain_text).join("") !== formatReflectionTitle(targetDate) ||
      date?.type !== "date" || date.date?.start !== targetDate || date.date.end || date.date.time_zone) {
    throw new Error(`Reflection property conflict: ${targetDate} (${id})`);
  }
  const paragraphs: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.blocks.children.list({ block_id: id, page_size: 100, start_cursor: cursor });
    for (const block of result.results) {
      if (!("type" in block) || block.type !== "paragraph" || block.has_children) {
        throw new Error(`Reflection content conflict: ${targetDate} (${id})`);
      }
      paragraphs.push(block.paragraph.rich_text.map(t => t.plain_text).join(""));
    }
    cursor = result.has_more ? result.next_cursor ?? undefined : undefined;
  } while (cursor);
  if (paragraphs.join("\n\n") !== reflection) {
    throw new Error(`Reflection content conflict: ${targetDate} (${id})`);
  }
}

export async function runDailyReflection(now = new Date(), options: Options = {}) {
  const schedule = getDailyReflectionSchedule(now);
  const { targetDate } = schedule;
  if (!schedule.due) return { status: "not-due" as const, targetDate };
  const dispatches = listEditedDailyReflections(targetDate, now.toISOString());
  const reflections = new Set(dispatches.map(d => extractReflection(d.content)).filter((s): s is string => s !== null));
  if (reflections.size === 0) return { status: "skipped" as const, targetDate, reason: "no edited reflection" };
  if (reflections.size > 1) throw new Error(`Multiple edited reflections conflict: ${targetDate}`);
  const [reflection] = reflections;
  // SDK v2 sends a single request; do not wrap create in a retry. A timed-out
  // POST may already have created the page and must reconcile by date first.
  const client = options.client ?? new Client({ auth: process.env.NOTION_API_KEY, timeoutMs: 15_000 });
  const existing = await pagesForDate(client, targetDate);
  if (existing.length > 1) throw new Error(`Multiple Notion reflections conflict: ${targetDate}`);
  if (existing.length === 1) {
    await verifyPage(client, existing[0].id, targetDate, reflection);
    return { status: "existing" as const, targetDate, pageId: existing[0].id };
  }
  if (options.dryRun) return { status: "would-create" as const, targetDate };
  const creationKey = `reflection_creation:${config.reflectionDatabaseId}:${targetDate}`;
  if (!claimReflectionCreation(creationKey, now.toISOString())) {
    throw new Error(`Reflection creation outcome is uncertain: ${targetDate}; inspect Notion before resetting ${creationKey}`);
  }
  const children = reflection.split("\n\n").map(paragraph => ({
    object: "block" as const, type: "paragraph" as const,
    paragraph: { rich_text: (paragraph.match(/[\s\S]{1,2000}/g) ?? [""]).map(content => ({
      type: "text" as const, text: { content },
    })) },
  }));
  const created = await client.pages.create({ parent: { database_id: config.reflectionDatabaseId },
    properties: { "이름": { title: [{ type: "text", text: { content: formatReflectionTitle(targetDate) } }] },
      "날짜": { date: { start: targetDate } } }, children });
  await verifyPage(client, created.id, targetDate, reflection);
  // Detect an unexpected concurrent/manual duplicate before recording success.
  const verified = await pagesForDate(client, targetDate);
  if (verified.length !== 1 || verified[0].id !== created.id) {
    throw new Error(`Reflection readback conflict: ${targetDate}`);
  }
  return { status: "created" as const, targetDate, pageId: created.id };
}
