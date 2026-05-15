import { shiftIsoDate, getKstDateInfo, toKstIsoDate } from "../lib/time";
import { loadEnvironment } from "../src/load-env";

const NOTION_VERSION = "2026-03-11";
const DEFAULT_CALENDAR_TITLE_PREFIX = "어센텀 업무";
const DEFAULT_CALENDAR_DATE_PROPERTY_NAME = "일정";
const DEFAULT_LINKED_VIEW_DATE_PROPERTY_NAME = "완료일";
const DEFAULT_LOOKBACK_DAYS = 2;
const DEFAULT_LOOKAHEAD_DAYS = 0;
const DEFAULT_MAX_BLOCK_DEPTH = 5;
const DATE_FILTER_OPERATORS = new Set([
  "after",
  "before",
  "equals",
  "on_or_after",
  "on_or_before",
]);

type JsonRecord = Record<string, unknown>;

interface Replacement<T> {
  value: T;
  changed: boolean;
}

interface LinkedViewFilterConfig {
  filter: unknown;
  quick_filters: unknown;
}

interface ReplaceLinkedViewDateFiltersOptions {
  datePropertyKeys: Set<string>;
  targetDate: string;
  forceDateFilters?: boolean;
}

interface DatabaseResponse {
  data_sources?: Array<{ id: string; name?: string }>;
}

interface DataSourceResponse {
  properties?: Record<string, { id: string; type: string }>;
}

interface ListResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

interface PageResponse {
  id: string;
  created_time?: string;
  properties?: Record<string, any>;
}

interface BlockResponse {
  id: string;
  type: string;
  has_children?: boolean;
  child_database?: { title?: string };
}

interface ViewReference {
  id: string;
}

interface ViewResponse {
  id: string;
  name?: string;
  type?: string;
  data_source_id?: string;
  filter?: unknown;
  quick_filters?: unknown;
}

interface ViewUpdateSummary {
  pageId: string;
  pageTitle: string;
  pageDate: string;
  childDatabaseId: string;
  viewId: string;
  viewName: string;
  changedFields: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer environment variable: ${name}=${raw}`);
  }

  return parsed;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid boolean environment variable: ${name}=${raw}`);
}

function optionalIsoDate(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`Invalid ISO date environment variable: ${name}=${raw}`);
  }
  return raw;
}

async function notionRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required("NOTION_API_KEY")}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Notion API request failed: ${path} ${response.status} ${body}`);
  }

  return body ? (JSON.parse(body) as T) : ({} as T);
}

async function retrieveDatabase(databaseId: string): Promise<DatabaseResponse> {
  return notionRequest<DatabaseResponse>(`/databases/${databaseId}`);
}

async function getFirstDataSourceId(databaseId: string): Promise<string> {
  const database = await retrieveDatabase(databaseId);
  const dataSourceId = database.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(`Database has no data sources: ${databaseId}`);
  }
  return dataSourceId;
}

async function retrieveDataSource(dataSourceId: string): Promise<DataSourceResponse> {
  return notionRequest<DataSourceResponse>(`/data_sources/${dataSourceId}`);
}

async function getDataSourcePropertyId(
  dataSourceId: string,
  propertyName: string
): Promise<string> {
  const dataSource = await retrieveDataSource(dataSourceId);
  const property = dataSource.properties?.[propertyName];
  if (!property?.id) {
    const available = Object.keys(dataSource.properties ?? {}).join(", ");
    throw new Error(
      `Property "${propertyName}" was not found in data source ${dataSourceId}. ` +
        `Available properties: ${available}`
    );
  }
  return property.id;
}

function buildPropertyKeys(propertyName: string, propertyId: string): Set<string> {
  return new Set([
    propertyName,
    propertyId,
    encodeURIComponent(propertyId),
    decodeURIComponent(propertyId),
  ]);
}

function replaceDateCondition(
  dateCondition: JsonRecord,
  targetDate: string,
  forceDateFilters: boolean
): Replacement<JsonRecord> {
  let next: JsonRecord | null = null;

  for (const [key, value] of Object.entries(dateCondition)) {
    if (!DATE_FILTER_OPERATORS.has(key) || typeof value !== "string") continue;
    if (value === targetDate) continue;
    if (value !== "today" && !forceDateFilters) continue;

    next ??= { ...dateCondition };
    next[key] = targetDate;
  }

  return next ? { value: next, changed: true } : { value: dateCondition, changed: false };
}

function replaceFilterNode(
  node: unknown,
  options: ReplaceLinkedViewDateFiltersOptions
): Replacement<unknown> {
  if (Array.isArray(node)) {
    let changed = false;
    const values = node.map((item) => {
      const replaced = replaceFilterNode(item, options);
      changed ||= replaced.changed;
      return replaced.value;
    });
    return changed ? { value: values, changed: true } : { value: node, changed: false };
  }

  if (!isRecord(node)) {
    return { value: node, changed: false };
  }

  const property = node.property;
  let next: JsonRecord | null = null;

  if (
    typeof property === "string" &&
    options.datePropertyKeys.has(property) &&
    isRecord(node.date)
  ) {
    const dateReplacement = replaceDateCondition(
      node.date,
      options.targetDate,
      options.forceDateFilters ?? false
    );
    if (dateReplacement.changed) {
      next ??= { ...node };
      next.date = dateReplacement.value;
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "date" && next?.date) continue;

    const childReplacement = replaceFilterNode(value, options);
    if (childReplacement.changed) {
      next ??= { ...node };
      next[key] = childReplacement.value;
    }
  }

  return next ? { value: next, changed: true } : { value: node, changed: false };
}

function replaceQuickFilterValue(
  value: unknown,
  options: ReplaceLinkedViewDateFiltersOptions
): Replacement<unknown> {
  if (!isRecord(value) || !isRecord(value.date)) {
    return { value, changed: false };
  }

  const replacedDate = replaceDateCondition(
    value.date,
    options.targetDate,
    options.forceDateFilters ?? false
  );
  if (!replacedDate.changed) {
    return { value, changed: false };
  }

  return {
    value: {
      ...value,
      date: replacedDate.value,
    },
    changed: true,
  };
}

function replaceQuickFilters(
  quickFilters: unknown,
  options: ReplaceLinkedViewDateFiltersOptions
): Replacement<unknown> {
  if (!isRecord(quickFilters)) {
    return { value: quickFilters, changed: false };
  }

  let next: JsonRecord | null = null;
  for (const [key, value] of Object.entries(quickFilters)) {
    if (!options.datePropertyKeys.has(key)) continue;

    const replacement = replaceQuickFilterValue(value, options);
    if (replacement.changed) {
      next ??= { ...quickFilters };
      next[key] = replacement.value;
    }
  }

  return next
    ? { value: next, changed: true }
    : { value: quickFilters, changed: false };
}

export function replaceLinkedViewDateFilters(
  config: LinkedViewFilterConfig,
  options: ReplaceLinkedViewDateFiltersOptions
): Replacement<LinkedViewFilterConfig> & { changedFields: string[] } {
  const filterReplacement = replaceFilterNode(config.filter, options);
  const quickFilterReplacement = replaceQuickFilters(config.quick_filters, options);
  const changedFields = [
    ...(filterReplacement.changed ? ["filter"] : []),
    ...(quickFilterReplacement.changed ? ["quick_filters"] : []),
  ];

  return {
    value: {
      filter: filterReplacement.value,
      quick_filters: quickFilterReplacement.value,
    },
    changed: changedFields.length > 0,
    changedFields,
  };
}

async function listBlockChildren(blockId: string): Promise<BlockResponse[]> {
  const blocks: BlockResponse[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);

    const response = await notionRequest<ListResponse<BlockResponse>>(
      `/blocks/${blockId}/children?${params.toString()}`
    );
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return blocks;
}

async function findChildDatabases(
  blockId: string,
  maxDepth: number,
  depth = 0
): Promise<BlockResponse[]> {
  const blocks = await listBlockChildren(blockId);
  const childDatabases: BlockResponse[] = [];

  for (const block of blocks) {
    if (block.type === "child_database") {
      childDatabases.push(block);
      continue;
    }

    if (block.has_children && depth < maxDepth) {
      childDatabases.push(...(await findChildDatabases(block.id, maxDepth, depth + 1)));
    }
  }

  return childDatabases;
}

export function getFirstBlockIdByType(
  blocks: Array<Pick<BlockResponse, "id" | "type">>,
  blockType: string
): string | null {
  return blocks.find((block) => block.type === blockType)?.id ?? null;
}

async function findChildDatabasesInFirstCallout(
  pageId: string,
  maxDepth: number
): Promise<BlockResponse[]> {
  const topLevelBlocks = await listBlockChildren(pageId);
  const calloutBlockId = getFirstBlockIdByType(topLevelBlocks, "callout");
  if (!calloutBlockId) return [];

  return findChildDatabases(calloutBlockId, maxDepth);
}

async function listViewsForDatabase(databaseId: string): Promise<ViewReference[]> {
  const views: ViewReference[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ database_id: databaseId });
    if (cursor) params.set("start_cursor", cursor);

    const response = await notionRequest<ListResponse<ViewReference>>(
      `/views?${params.toString()}`
    );
    views.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return views;
}

async function retrieveView(viewId: string): Promise<ViewResponse> {
  return notionRequest<ViewResponse>(`/views/${viewId}`);
}

async function updateView(viewId: string, body: JsonRecord): Promise<void> {
  await notionRequest<ViewResponse>(`/views/${viewId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function getPageTitle(page: PageResponse): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property?.type === "title") {
      return property.title.map((item: any) => item.plain_text).join("");
    }
  }
  return "";
}

function getPageDate(page: PageResponse, propertyName: string): string | null {
  const property = page.properties?.[propertyName];
  if (!property || property.type !== "date") return null;

  const start = property.date?.start;
  return typeof start === "string" ? toKstIsoDate(start) : null;
}

async function queryCalendarPages(
  calendarDataSourceId: string,
  calendarDatePropertyName: string,
  startDate: string,
  endDate: string
): Promise<PageResponse[]> {
  const pages: PageResponse[] = [];
  let cursor: string | undefined;

  do {
    const response = await notionRequest<ListResponse<PageResponse>>(
      `/data_sources/${calendarDataSourceId}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: calendarDatePropertyName,
                date: { on_or_after: startDate },
              },
              {
                property: calendarDatePropertyName,
                date: { on_or_before: endDate },
              },
            ],
          },
          sorts: [{ property: calendarDatePropertyName, direction: "ascending" }],
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      }
    );

    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return pages;
}

async function updateLinkedViewsForPage(input: {
  pageId: string;
  pageTitle: string;
  pageDate: string;
  maxBlockDepth: number;
  workDataSourceId: string;
  datePropertyKeys: Set<string>;
  forceDateFilters: boolean;
  dryRun: boolean;
}): Promise<{ viewsChecked: number; viewsUpdated: number; updates: ViewUpdateSummary[] }> {
  const childDatabases = await findChildDatabasesInFirstCallout(
    input.pageId,
    input.maxBlockDepth
  );
  const updates: ViewUpdateSummary[] = [];
  let viewsChecked = 0;
  let viewsUpdated = 0;

  for (const childDatabase of childDatabases) {
    const viewReferences = await listViewsForDatabase(childDatabase.id);

    for (const viewReference of viewReferences) {
      const view = await retrieveView(viewReference.id);
      if (view.data_source_id !== input.workDataSourceId) continue;

      viewsChecked += 1;
      const replacement = replaceLinkedViewDateFilters(
        {
          filter: view.filter ?? null,
          quick_filters: view.quick_filters ?? null,
        },
        {
          datePropertyKeys: input.datePropertyKeys,
          targetDate: input.pageDate,
          forceDateFilters: input.forceDateFilters,
        }
      );

      if (!replacement.changed) continue;

      const body: JsonRecord = {};
      if (replacement.changedFields.includes("filter")) {
        body.filter = replacement.value.filter;
      }
      if (replacement.changedFields.includes("quick_filters")) {
        body.quick_filters = replacement.value.quick_filters;
      }

      if (!input.dryRun) {
        await updateView(view.id, body);
      }

      viewsUpdated += 1;
      updates.push({
        pageId: input.pageId,
        pageTitle: input.pageTitle,
        pageDate: input.pageDate,
        childDatabaseId: childDatabase.id,
        viewId: view.id,
        viewName: view.name ?? "(unnamed view)",
        changedFields: replacement.changedFields,
      });
    }
  }

  return { viewsChecked, viewsUpdated, updates };
}

async function main() {
  loadEnvironment();

  const calendarDatabaseId =
    process.env.NOTION_WORK_CALENDAR_DB_ID ?? process.env.NOTION_LEGACY_WORK_DB_ID;
  if (!calendarDatabaseId) {
    throw new Error(
      "Missing NOTION_WORK_CALENDAR_DB_ID. " +
        "Set it to the 업무 캘린더 DB database ID."
    );
  }

  const workDatabaseId = required("NOTION_WORK_DB_ID");
  const calendarDataSourceId =
    process.env.NOTION_WORK_CALENDAR_DATA_SOURCE_ID ??
    (await getFirstDataSourceId(calendarDatabaseId));
  const workDataSourceId =
    process.env.NOTION_WORK_DATA_SOURCE_ID ?? (await getFirstDataSourceId(workDatabaseId));

  const calendarTitlePrefix =
    process.env.NOTION_WORK_CALENDAR_TITLE_PREFIX ?? DEFAULT_CALENDAR_TITLE_PREFIX;
  const calendarDatePropertyName =
    process.env.NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME ??
    DEFAULT_CALENDAR_DATE_PROPERTY_NAME;
  const linkedViewDatePropertyName =
    process.env.NOTION_LINKED_VIEW_DATE_PROPERTY_NAME ??
    DEFAULT_LINKED_VIEW_DATE_PROPERTY_NAME;
  const linkedViewDatePropertyId =
    process.env.NOTION_LINKED_VIEW_DATE_PROPERTY_ID ??
    (await getDataSourcePropertyId(workDataSourceId, linkedViewDatePropertyName));

  const targetDate = optionalIsoDate("TARGET_DATE") ?? getKstDateInfo().isoDate;
  const lookbackDays = optionalInteger(
    "NOTION_WORK_CALENDAR_LOOKBACK_DAYS",
    DEFAULT_LOOKBACK_DAYS
  );
  const lookaheadDays = optionalInteger(
    "NOTION_WORK_CALENDAR_LOOKAHEAD_DAYS",
    DEFAULT_LOOKAHEAD_DAYS
  );
  const maxBlockDepth = optionalInteger(
    "NOTION_WORK_CALENDAR_MAX_BLOCK_DEPTH",
    DEFAULT_MAX_BLOCK_DEPTH
  );
  const forceDateFilters = optionalBoolean("NOTION_LINKED_VIEW_FORCE_DATE_FILTERS", false);
  const dryRun =
    optionalBoolean("DRY_RUN", false) || optionalBoolean("NOTION_DRY_RUN", false);
  const startDate = shiftIsoDate(targetDate, -lookbackDays);
  const endDate = shiftIsoDate(targetDate, lookaheadDays);
  const datePropertyKeys = buildPropertyKeys(
    linkedViewDatePropertyName,
    linkedViewDatePropertyId
  );

  const calendarPages = await queryCalendarPages(
    calendarDataSourceId,
    calendarDatePropertyName,
    startDate,
    endDate
  );
  const targetPages = calendarPages
    .map((page) => ({
      page,
      title: getPageTitle(page),
      date: getPageDate(page, calendarDatePropertyName),
    }))
    .filter(
      (entry): entry is { page: PageResponse; title: string; date: string } =>
        entry.date !== null && entry.title.trimStart().startsWith(calendarTitlePrefix)
    );

  const updates: ViewUpdateSummary[] = [];
  let viewsChecked = 0;
  let viewsUpdated = 0;

  for (const targetPage of targetPages) {
    const result = await updateLinkedViewsForPage({
      pageId: targetPage.page.id,
      pageTitle: targetPage.title,
      pageDate: targetPage.date,
      maxBlockDepth,
      workDataSourceId,
      datePropertyKeys,
      forceDateFilters,
      dryRun,
    });

    viewsChecked += result.viewsChecked;
    viewsUpdated += result.viewsUpdated;
    updates.push(...result.updates);
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        targetDate,
        startDate,
        endDate,
        calendarDatabaseId,
        calendarDataSourceId,
        workDatabaseId,
        workDataSourceId,
        linkedViewDatePropertyName,
        linkedViewDatePropertyId,
        calendarPagesScanned: calendarPages.length,
        targetPagesMatched: targetPages.length,
        viewsChecked,
        viewsUpdated,
        updates,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
