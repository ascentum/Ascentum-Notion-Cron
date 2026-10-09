import { randomUUID } from "node:crypto";
import { getKstDateInfo, shiftIsoDate } from "../../lib/time";
import {
  buildPropertyKeys,
  getFirstDataSourceId,
  getPageDate,
  listLinkedWorkViews,
  notionRequest,
  NotionApiError,
  PageResponse,
  queryCalendarPages,
  replaceLinkedViewDateFilters,
  retrieveDataSource,
  ViewResponse,
} from "../../lib/work-calendar";
import {
  claimCalendarPageRun,
  releaseCalendarPageRun,
  saveCalendarPageRun,
} from "../database";

export const DEFAULT_HAMILTON_USER_ID = "3f0d872b-594c-81a9-a34d-00024bd9314d";
export const DEFAULT_HAMILTON_TEMPLATE_ID = "3f2bd55c-4778-8043-9ed0-d337f8b50734";

export function getHamiltonCalendarSchedule(now: Date) {
  const { isoDate, weekday } = getKstDateInfo(now);
  const hour = new Date(now.getTime() + 9 * 60 * 60_000).getUTCHours();
  return {
    triggerDate: isoDate,
    targetDate: shiftIsoDate(isoDate, 1),
    due: weekday >= 2 && weekday <= 6 && hour >= 13,
  };
}

function validateTargetDate(targetDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error("Invalid target date");
  const date = new Date(`${targetDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== targetDate) {
    throw new Error("Invalid target date");
  }
  if (![0, 3, 4, 5, 6].includes(date.getUTCDay())) {
    throw new Error("Hamilton target date must be Wednesday through Sunday");
  }
}

type LinkedView = ViewResponse & { childDatabaseId: string };

// View names alone cannot prove that the asynchronous template has applied its
// filters. Compare the top table blueprint with its completion date normalized.
function normalizedView(view: LinkedView, keys: Set<string>, targetDate: string, datePropertyId: string) {
  return replaceLinkedViewDateFilters(
    { filter: view.filter ?? null, quick_filters: view.quick_filters ?? null },
    { datePropertyKeys: keys, targetDate, forceDateFilters: true, ensureDatePropertyKey: datePropertyId }
  ).value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasTemplateViews(
  views: LinkedView[], blueprint: LinkedView[], keys: Set<string>, targetDate: string, datePropertyId: string
): boolean {
  const remaining = [...views];
  for (const expected of blueprint) {
    const index = remaining.findIndex((view) => view.name === expected.name &&
      canonical(normalizedView(view, keys, targetDate, datePropertyId)) ===
      canonical(normalizedView(expected, keys, targetDate, datePropertyId)));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

export interface HamiltonCalendarOptions {
  targetDate?: string;
  dryRun?: boolean;
  // Tests replace waiting, not the Notion behavior itself.
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runHamiltonCalendar(
  now = new Date(), options: HamiltonCalendarOptions = {}
) {
  const schedule = getHamiltonCalendarSchedule(now);
  if (!options.targetDate && !schedule.due) {
    return { status: "not-due", targetDate: schedule.targetDate };
  }
  const targetDate = options.targetDate ?? schedule.targetDate;
  validateTargetDate(targetDate);
  const dryRun = options.dryRun === true;
  if (!dryRun && process.env.HAMILTON_NOTION_REPEAT_DISABLED !== "true") {
    throw new Error("Confirm Hamilton Notion repeating template is disabled: HAMILTON_NOTION_REPEAT_DISABLED=true");
  }

  const owner = randomUUID();
  const state = dryRun ? null : claimCalendarPageRun(targetDate, owner, new Date());
  if (!dryRun && !state) return { status: "locked", targetDate };

  try {
    const calendarDatabaseId = process.env.NOTION_WORK_CALENDAR_DB_ID ??
      process.env.NOTION_LEGACY_WORK_DB_ID;
    const workDatabaseId = process.env.NOTION_WORK_DB_ID;
    if (!calendarDatabaseId || !workDatabaseId) {
      throw new Error("NOTION_WORK_CALENDAR_DB_ID and NOTION_WORK_DB_ID are required");
    }
    const calendarDataSourceId = process.env.NOTION_WORK_CALENDAR_DATA_SOURCE_ID ??
      await getFirstDataSourceId(calendarDatabaseId);
    const workDataSourceId = process.env.NOTION_WORK_DATA_SOURCE_ID ??
      await getFirstDataSourceId(workDatabaseId);
    const personId = process.env.NOTION_USER_HAMILTON ?? DEFAULT_HAMILTON_USER_ID;
    const templateId = process.env.NOTION_HAMILTON_CALENDAR_TEMPLATE_ID ?? DEFAULT_HAMILTON_TEMPLATE_ID;
    const dateName = process.env.NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME ?? "일정";
    const personName = process.env.NOTION_WORK_CALENDAR_PERSON_PROPERTY_NAME ?? "사람";
    const completionName = process.env.NOTION_LINKED_VIEW_DATE_PROPERTY_NAME ?? "완료일";
    const calendarSchema = await retrieveDataSource(calendarDataSourceId);
    const workSchema = await retrieveDataSource(workDataSourceId);
    const titleName = Object.entries(calendarSchema.properties ?? {})
      .find(([, property]) => property.type === "title")?.[0];
    const completionId = process.env.NOTION_LINKED_VIEW_DATE_PROPERTY_ID ??
      workSchema.properties?.[completionName]?.id;
    if (!titleName || calendarSchema.properties?.[dateName]?.type !== "date" ||
      calendarSchema.properties?.[personName]?.type !== "people" ||
      !completionId || workSchema.properties?.[completionName]?.type !== "date") {
      throw new Error("Calendar/title/people or work completion-date schema is invalid");
    }
    const dateKeys = buildPropertyKeys(completionName, completionId);
    const template = await notionRequest<PageResponse & { parent?: { data_source_id?: string }; archived?: boolean; in_trash?: boolean }>(`/pages/${templateId}`);
    const templatePeople = template.properties?.[personName]?.people;
    if (template.archived || template.in_trash || template.parent?.data_source_id !== calendarDataSourceId ||
      !Array.isArray(templatePeople) || templatePeople.length !== 1 || templatePeople[0].id !== personId) {
      throw new Error("Hamilton template must belong to the calendar and have only Hamilton as its person");
    }
    const viewOptions = { maxBlockDepth: 5, workDataSourceId, scope: "today-work" as const };
    const blueprint = await listLinkedWorkViews(templateId, viewOptions);
    if (blueprint.length !== 1) {
      throw new Error("Hamilton template must have one top 오늘의 업무 table");
    }
    const existing = await queryCalendarPages({
      calendarDataSourceId, calendarDatePropertyName: dateName,
      calendarPersonPropertyName: personName, calendarPersonId: personId,
      startDate: targetDate, endDate: targetDate,
    });
    if (existing.length > 1) throw new Error(`Multiple Hamilton pages exist for ${targetDate}`);
    const titlePrefix = `${process.env.NOTION_WORK_CALENDAR_TITLE_PREFIX ?? "어센텀 업무"} `;
    const title = `${titlePrefix}@${targetDate}`;
    const titleRichText = [
      { type: "text", text: { content: titlePrefix } },
      { type: "mention", mention: { type: "date", date: { start: targetDate } } },
    ];
    // Public API date mentions default to absolute display. Do not rewrite an
    // already correct mention: that would erase a relative format set in Notion.
    const hasTargetTitle = (page: PageResponse) => {
      const parts = page.properties?.[titleName]?.title;
      return Array.isArray(parts) && parts.length === 2 &&
        parts[0]?.type === "text" && parts[0]?.text?.content === titlePrefix &&
        parts[1]?.type === "mention" && parts[1]?.mention?.type === "date" &&
        parts[1]?.mention?.date?.start === targetDate && !parts[1]?.mention?.date?.end;
    };
    if (dryRun) return {
      status: existing.length ? "would-repair" : "would-create", dryRun, targetDate,
      title, templateId, personId, pageId: existing[0]?.id ?? state?.pageId ?? null,
      expectedViews: blueprint.map((view) => view.name),
    };
    const existingPage = existing[0];
    if (state?.pageId && existingPage && state.pageId !== existingPage.id) {
      throw new Error(`Stored Hamilton page differs from query result for ${targetDate}`);
    }
    let pageId = existingPage?.id ?? state?.pageId;
    const reused = Boolean(pageId);
    if (!pageId) {
      if (state?.creationRequested) {
        throw new Error(`Hamilton creation outcome is uncertain for ${targetDate}; no second POST will be sent. Inspect Notion and calendar_page_runs before retrying.`);
      }
      saveCalendarPageRun(targetDate, owner, { creationRequested: true });
      let created: PageResponse;
      try {
        created = await notionRequest<PageResponse>("/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { type: "data_source_id", data_source_id: calendarDataSourceId },
            properties: {
              [titleName]: { title: titleRichText },
              [dateName]: { date: { start: targetDate } },
              [personName]: { people: [{ id: personId }] },
            },
            template: { type: "template_id", template_id: templateId, timezone: "Asia/Seoul" },
          }),
        });
      } catch (error) {
        // A rejected request can be retried; network/server failures remain
        // uncertain because Notion may have created the page already.
        if (error instanceof NotionApiError && [400, 401, 403, 404, 422, 429].includes(error.status)) {
          saveCalendarPageRun(targetDate, owner, { creationRequested: false });
        }
        throw error;
      }
      pageId = created.id;
      if (!pageId) throw new Error("Notion creation response has no page ID");
    }
    saveCalendarPageRun(targetDate, owner, { pageId });
    const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let views: LinkedView[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      saveCalendarPageRun(targetDate, owner, {});
      views = await listLinkedWorkViews(pageId, viewOptions);
      if (hasTemplateViews(views, blueprint, dateKeys, targetDate, completionId)) break;
      if (attempt === 7) throw new Error(`Hamilton template views are not ready for ${pageId}`);
      await wait(Math.min(2_000 * 2 ** attempt, 20_000));
    }
    // Apply properties after hydration too, replacing a template title only if
    // its date is wrong or it is not the intended native date mention.
    saveCalendarPageRun(targetDate, owner, {});
    const hydratedPage = await notionRequest<PageResponse>(`/pages/${pageId}`);
    await notionRequest(`/pages/${pageId}`, {
      method: "PATCH", body: JSON.stringify({ properties: {
        ...(hasTargetTitle(hydratedPage) ? {} : { [titleName]: { title: titleRichText } }),
        [dateName]: { date: { start: targetDate } },
        [personName]: { people: [{ id: personId }] },
      } }),
    });
    let viewsUpdated = 0;
    for (const view of views) {
      const replacement = replaceLinkedViewDateFilters(
        { filter: view.filter ?? null, quick_filters: view.quick_filters ?? null },
        { datePropertyKeys: dateKeys, targetDate, forceDateFilters: true, ensureDatePropertyKey: completionId }
      );
      if (!replacement.changed) continue;
      saveCalendarPageRun(targetDate, owner, {});
      const body: Record<string, unknown> = {};
      for (const field of replacement.changedFields) {
        body[field] = replacement.value[field as "filter" | "quick_filters"];
      }
      await notionRequest(`/views/${view.id}`, { method: "PATCH", body: JSON.stringify(body) });
      viewsUpdated++;
    }
    const verifiedViews = await listLinkedWorkViews(pageId, viewOptions);
    if (!hasTemplateViews(verifiedViews, blueprint, dateKeys, targetDate, completionId) ||
      verifiedViews.some((view) => replaceLinkedViewDateFilters(
        { filter: view.filter ?? null, quick_filters: view.quick_filters ?? null },
        { datePropertyKeys: dateKeys, targetDate, forceDateFilters: true, ensureDatePropertyKey: completionId }
      ).changed)) {
      throw new Error(`Hamilton page filter verification failed for ${pageId}`);
    }
    const verified = await notionRequest<PageResponse>(`/pages/${pageId}`);
    const people = verified.properties?.[personName]?.people;
    // Date mention plain_text is a display label, not a stable identifier.
    if (!hasTargetTitle(verified) || getPageDate(verified, dateName) !== targetDate ||
      !Array.isArray(people) || people.length !== 1 || people[0].id !== personId) {
      throw new Error(`Hamilton page property verification failed for ${pageId}`);
    }
    saveCalendarPageRun(targetDate, owner, { completed: true });
    return { status: reused ? "repaired" : "created", targetDate, pageId, title, viewsUpdated };
  } finally {
    if (!dryRun) releaseCalendarPageRun(targetDate, owner);
  }
}
