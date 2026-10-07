import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PERSON = "hamilton-user";
const TEMPLATE = "hamilton-template";
const TARGET = "2026-10-07";
const NOW = new Date("2026-10-06T04:00:00Z");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
type Json = Record<string, any>;

// The fake speaks the same HTTP/block/view API as Notion. The service itself
// remains unmocked; even hydration and response-loss scenarios use fetch.
class NotionFake {
  calls: Array<{ method: string; path: string; body: Json }> = [];
  pages = new Map<string, Json>();
  views = new Map<string, Json>();
  templatePeople = [{ id: PERSON }];
  templateParent = "calendar-source";
  hydration = false;
  rootReads = 0;
  incomplete = false;
  failViewPatch = false;
  loseCreateResponse = false;
  rejectCreateStatus?: number;
  hideCreated = false;
  queryGate?: () => Promise<void>;
  onCreatedPageDiscovery?: () => void;
  expectedDate = TARGET;

  constructor() { this.seedViews(TEMPLATE); }

  seedViews(pageId: string) {
    this.views.set(`${pageId}-inside-view`, {
      id: `${pageId}-inside-view`, name: "Hamilton", data_source_id: "work-source",
      filter: { and: [
        { property: "사람", people: { contains: PERSON } },
        { property: "완료일", date: { equals: "today" } },
      ] },
      quick_filters: { "done%3Aid": { date: { on_or_after: "today" } } },
    });
    this.views.set(`${pageId}-outside-view`, {
      id: `${pageId}-outside-view`, name: "Archy", data_source_id: "work-source",
      filter: { or: [
        { and: [
          { property: "사람", people: { contains: "archy-user" } },
          { property: "done:id", date: { equals: "today" } },
        ] },
        { property: "완료일", date: { equals: "2026-01-01" } },
        { property: "다른날짜", date: { equals: "today" } },
      ] }, quick_filters: null,
    });
  }

  savePage(id: string, properties: Json) {
    const responseProperties: Json = {};
    for (const [name, value] of Object.entries(properties)) {
      const type = Object.keys(value)[0];
      responseProperties[name] = { ...clone(value), type };
      if (type === "title") responseProperties[name].title = value.title.map((part: Json) => ({
        ...part, plain_text: part.text.content,
      }));
    }
    const page = { id, parent: { data_source_id: "calendar-source" }, properties: responseProperties };
    this.pages.set(id, page);
    return page;
  }

  addExisting(id = "created-page") {
    this.savePage(id, {
      이름: { title: [{ text: { content: `어센텀 업무 ${this.expectedDate}` } }] },
      일정: { date: { start: this.expectedDate } }, 사람: { people: [{ id: PERSON }] },
    });
    this.seedViews(id);
  }

  get creates() { return this.calls.filter((call) => call.method === "POST" && call.path === "/pages"); }
  get writes() { return this.calls.filter((call) => call.method === "PATCH" || call.path === "/pages"); }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, "https://api.notion.com");
    const route = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push({ method, path: route, body: clone(body) });
    const respond = (value: unknown, status = 200) => new Response(JSON.stringify(clone(value)), { status });
    if (route === "/databases/calendar-db") return respond({ data_sources: [{ id: "calendar-source" }] });
    if (route === "/databases/work-db") return respond({ data_sources: [{ id: "work-source" }] });
    if (route === "/data_sources/calendar-source") return respond({ properties: {
      이름: { id: "title", type: "title" }, 일정: { id: "date", type: "date" }, 사람: { id: "people", type: "people" },
    } });
    if (route === "/data_sources/work-source") return respond({ properties: { 완료일: { id: "done:id", type: "date" } } });
    if (route === `/pages/${TEMPLATE}`) return respond({
      id: TEMPLATE, parent: { data_source_id: this.templateParent }, properties: { 사람: { type: "people", people: this.templatePeople } },
    });
    if (route === "/data_sources/calendar-source/query") {
      assert.deepEqual(body.filter, { and: [
        { property: "일정", date: { on_or_after: this.expectedDate } },
        { property: "일정", date: { on_or_before: this.expectedDate } },
        { property: "사람", people: { contains: PERSON } },
      ] });
      await this.queryGate?.();
      return respond(list(this.hideCreated ? [] : [...this.pages.values()]));
    }
    if (route === "/pages" && method === "POST") {
      if (this.rejectCreateStatus !== undefined) {
        const status = this.rejectCreateStatus;
        this.rejectCreateStatus = undefined;
        return respond({ message: `Simulated creation rejection ${status}` }, status);
      }
      this.savePage("created-page", body.properties);
      this.seedViews("created-page");
      if (this.loseCreateResponse) throw new Error("Simulated creation response loss");
      return respond(this.pages.get("created-page"));
    }
    const pageMatch = route.match(/^\/pages\/(.+)$/);
    if (pageMatch && this.pages.has(pageMatch[1])) {
      if (method === "PATCH") this.savePage(pageMatch[1], body.properties);
      return respond(this.pages.get(pageMatch[1]));
    }
    const blockMatch = route.match(/^\/blocks\/(.+)\/children$/);
    if (blockMatch) {
      const id = blockMatch[1];
      if (id.endsWith("-callout")) return respond(list([
        { id: id.replace(/-callout$/, "-inside"), type: "child_database" },
      ]));
      assert.ok(id === TEMPLATE || this.pages.has(id), `Unexpected block ${id}`);
      if (id !== TEMPLATE) {
        this.onCreatedPageDiscovery?.();
        this.rootReads++;
        this.incomplete = this.hydration && this.rootReads === 2;
        if (this.hydration && this.rootReads === 1) return respond(list([]));
      }
      return respond(list([
        { id: `${id}-callout`, type: "callout", has_children: true },
        { id: `${id}-outside`, type: "child_database" },
      ]));
    }
    if (route === "/views") return respond(list([{ id: `${url.searchParams.get("database_id")}-view` }]));
    const viewMatch = route.match(/^\/views\/(.+)$/);
    if (viewMatch && this.views.has(viewMatch[1])) {
      const view = this.views.get(viewMatch[1])!;
      if (method === "PATCH") {
        if (this.failViewPatch) { this.failViewPatch = false; return respond({ message: "temporary patch failure" }, 500); }
        Object.assign(view, clone(body));
      }
      return respond(this.incomplete && !view.id.startsWith(TEMPLATE) ? { ...view, filter: null, quick_filters: null } : view);
    }
    throw new Error(`Unexpected fake Notion request: ${method} ${url.href}`);
  };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hamilton-calendar-test-"));
  const originalFetch = global.fetch;
  const fixture: Record<string, string | undefined> = {
    SQLITE_DB_PATH: path.join(tempDir, "automation.sqlite"), NOTION_API_KEY: "fake-key-no-credentials",
    NOTION_WORK_CALENDAR_DB_ID: "calendar-db", NOTION_WORK_DB_ID: "work-db",
    NOTION_USER_HAMILTON: PERSON, NOTION_HAMILTON_CALENDAR_TEMPLATE_ID: TEMPLATE,
    HAMILTON_NOTION_REPEAT_DISABLED: "true",
    NOTION_WORK_CALENDAR_DATA_SOURCE_ID: undefined, NOTION_WORK_DATA_SOURCE_ID: undefined,
    NOTION_WORK_CALENDAR_DATE_PROPERTY_NAME: undefined, NOTION_WORK_CALENDAR_PERSON_PROPERTY_NAME: undefined,
    NOTION_WORK_CALENDAR_TITLE_PREFIX: undefined, NOTION_LINKED_VIEW_DATE_PROPERTY_NAME: undefined,
    NOTION_LINKED_VIEW_DATE_PROPERTY_ID: undefined,
  };
  const originalEnv = Object.fromEntries(Object.keys(fixture).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(fixture)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  let db: DatabaseSync | undefined;
  let closeServiceDatabase: (() => void) | undefined;
  try {
    const { getHamiltonCalendarSchedule, runHamiltonCalendar } = await import("../src/services/hamilton-calendar-service");
    closeServiceDatabase = (await import("../src/database")).closeDatabase;
    for (let day = 6; day <= 10; day++) {
      const triggerDate = `2026-10-${String(day).padStart(2, "0")}`;
      const targetDate = `2026-10-${String(day + 1).padStart(2, "0")}`;
      assert.deepEqual(getHamiltonCalendarSchedule(new Date(`${triggerDate}T04:00:00Z`)), { triggerDate, targetDate, due: true });
      assert.equal(getHamiltonCalendarSchedule(new Date(`${triggerDate}T03:59:59Z`)).due, false);
    }
    for (const date of ["2026-10-04", "2026-10-05"]) {
      assert.equal(getHamiltonCalendarSchedule(new Date(`${date}T14:59:59Z`)).due, false);
    }
    assert.equal(getHamiltonCalendarSchedule(new Date("2026-12-31T04:00:00Z")).targetDate, "2027-01-01");
    assert.equal(getHamiltonCalendarSchedule(new Date("2026-10-31T04:00:00Z")).targetDate, "2026-11-01");
    assert.equal(getHamiltonCalendarSchedule(new Date("2028-02-29T04:00:00Z")).targetDate, "2028-03-01");

    let fake = new NotionFake();
    global.fetch = fake.fetch;
    assert.equal((await runHamiltonCalendar(new Date("2026-10-06T03:59:59Z"))).status, "not-due");
    assert.equal(fake.calls.length, 0);
    for (const targetDate of ["2026-02-30", "2026-2-03", "garbage", "2026-10-05", "2026-10-06"]) {
      await assert.rejects(runHamiltonCalendar(NOW, { targetDate }), /Invalid target date|Wednesday through Sunday/);
    }
    assert.equal(fake.calls.length, 0);
    delete process.env.HAMILTON_NOTION_REPEAT_DISABLED;
    await assert.rejects(runHamiltonCalendar(NOW), /repeating template is disabled/);
    assert.equal((await runHamiltonCalendar(NOW, { dryRun: true })).status, "would-create");
    assert.equal(fake.writes.length, 0);
    assert.equal(fs.existsSync(fixture.SQLITE_DB_PATH!), false, "dry-run must not initialize or claim SQLite");
    process.env.HAMILTON_NOTION_REPEAT_DISABLED = "true";
    fake.addExisting();
    assert.equal((await runHamiltonCalendar(NOW, { dryRun: true })).status, "would-repair");
    assert.equal(fake.writes.length, 0);
    assert.equal(fs.existsSync(fixture.SQLITE_DB_PATH!), false);

    const reset = () => {
      db?.exec("DELETE FROM calendar_page_runs");
      fake = new NotionFake(); global.fetch = fake.fetch;
      return fake;
    };
    fake = reset(); fake.templatePeople = [{ id: "other" }];
    await assert.rejects(runHamiltonCalendar(NOW), /only Hamilton/);
    db = new DatabaseSync(fixture.SQLITE_DB_PATH!);
    assert.equal(fake.creates.length, 0);
    for (const people of [[], [{ id: PERSON }, { id: "other" }]]) {
      fake = reset(); fake.templatePeople = people;
      await assert.rejects(runHamiltonCalendar(NOW), /only Hamilton/);
      assert.equal(fake.creates.length, 0);
    }
    fake = reset(); fake.templateParent = "other-source";
    await assert.rejects(runHamiltonCalendar(NOW), /belong to the calendar/);
    assert.equal(fake.creates.length, 0);
    fake = reset(); fake.addExisting("duplicate-one"); fake.addExisting("duplicate-two");
    await assert.rejects(runHamiltonCalendar(NOW), /Multiple Hamilton pages/);
    assert.equal(fake.creates.length, 0);

    fake = reset(); fake.hydration = true;
    const waits: number[] = [];
    const created = await runHamiltonCalendar(NOW, { wait: async (ms) => { waits.push(ms); } });
    assert.equal(created.status, "created");
    assert.deepEqual(waits, [2000, 4000], "empty and named-but-incomplete views must both wait");
    assert.equal(created.viewsUpdated, 2);
    assert.equal(fake.creates.length, 1);
    assert.deepEqual(fake.creates[0].body, {
      parent: { type: "data_source_id", data_source_id: "calendar-source" },
      properties: {
        이름: { title: [{ text: { content: `어센텀 업무 ${TARGET}` } }] },
        일정: { date: { start: TARGET } }, 사람: { people: [{ id: PERSON }] },
      }, template: { type: "template_id", template_id: TEMPLATE, timezone: "Asia/Seoul" },
    });
    const archy = fake.views.get("created-page-outside-view")!;
    assert.deepEqual(archy.filter, { or: [
      { and: [{ property: "사람", people: { contains: "archy-user" } }, { property: "done:id", date: { equals: TARGET } }] },
      { property: "완료일", date: { equals: "2026-01-01" } },
      { property: "다른날짜", date: { equals: "today" } },
    ] });
    assert.equal(fake.views.get("created-page-inside-view")!.quick_filters["done%3Aid"].date.on_or_after, TARGET);
    assert.equal((await runHamiltonCalendar(NOW, { wait: async () => {} })).status, "repaired");
    assert.equal(fake.creates.length, 1);
    assert.equal(Number(db.prepare("SELECT completed FROM calendar_page_runs").get()!.completed), 1);

    fake = reset(); fake.failViewPatch = true;
    await assert.rejects(runHamiltonCalendar(NOW, { wait: async () => {} }), /temporary patch failure/);
    assert.equal(db.prepare("SELECT page_id FROM calendar_page_runs").get()!.page_id, "created-page");
    fake.hideCreated = true; // Saved ID also recovers when Notion query has not indexed the page.
    assert.equal((await runHamiltonCalendar(NOW, { wait: async () => {} })).status, "repaired");
    assert.equal(fake.creates.length, 1);

    fake = reset(); fake.loseCreateResponse = true; fake.hideCreated = true;
    await assert.rejects(runHamiltonCalendar(NOW), /creation response loss/);
    const uncertain = db.prepare("SELECT * FROM calendar_page_runs").get()!;
    assert.equal(Number(uncertain.creation_requested), 1);
    assert.equal(uncertain.page_id, null);
    assert.equal(uncertain.lock_owner, null);
    await assert.rejects(runHamiltonCalendar(NOW), /outcome is uncertain/);
    assert.equal(fake.creates.length, 1);
    fake.hideCreated = false;
    assert.equal((await runHamiltonCalendar(NOW, { wait: async () => {} })).status, "repaired");
    assert.equal(fake.creates.length, 1);

    for (const status of [400, 429]) {
      fake = reset(); fake.rejectCreateStatus = status;
      await assert.rejects(runHamiltonCalendar(NOW), new RegExp(`creation rejection ${status}`));
      assert.equal(Number(db.prepare("SELECT creation_requested FROM calendar_page_runs").get()!.creation_requested), 0);
      assert.equal(fake.pages.size, 0, "definitive rejection occurs before creating a page");
      assert.equal((await runHamiltonCalendar(NOW, { wait: async () => {} })).status, "created");
      assert.equal(fake.creates.length, 2, "definitive rejection permits one successful retry");
      assert.equal(fake.pages.size, 1);
    }
    fake = reset(); fake.rejectCreateStatus = 500;
    await assert.rejects(runHamiltonCalendar(NOW), /creation rejection 500/);
    assert.equal(Number(db.prepare("SELECT creation_requested FROM calendar_page_runs").get()!.creation_requested), 1);
    await assert.rejects(runHamiltonCalendar(NOW), /outcome is uncertain/);
    assert.equal(fake.creates.length, 1, "a server error keeps the creation outcome uncertain");

    fake = reset(); fake.failViewPatch = true;
    await assert.rejects(runHamiltonCalendar(NOW, { wait: async () => {} }), /temporary patch failure/);
    fake.hideCreated = true;
    const pending = db.prepare("SELECT * FROM calendar_page_runs").get()!;
    assert.equal(pending.page_id, "created-page");
    assert.equal(Number(pending.completed), 0);
    db.prepare("UPDATE calendar_page_runs SET lock_owner = ?, lock_until = ? WHERE target_date = ?")
      .run("previous-process", new Date(Date.now() + 60_000).toISOString(), TARGET);
    closeServiceDatabase();
    db.close();
    db = new DatabaseSync(fixture.SQLITE_DB_PATH!);
    const callsBeforeRestart = fake.calls.length;
    assert.equal((await runHamiltonCalendar(NOW)).status, "locked");
    assert.equal(fake.calls.length, callsBeforeRestart, "an unexpired persisted lease survives restart");
    db.prepare("UPDATE calendar_page_runs SET lock_until = ? WHERE target_date = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), TARGET);
    closeServiceDatabase();
    db.close();
    db = new DatabaseSync(fixture.SQLITE_DB_PATH!);
    assert.equal((await runHamiltonCalendar(NOW, { wait: async () => {} })).status, "repaired");
    assert.equal(fake.creates.length, 1, "a restart recovers the persisted pending page without another POST");
    assert.equal(Number(db.prepare("SELECT completed FROM calendar_page_runs").get()!.completed), 1);
    assert.equal(db.prepare("SELECT lock_owner FROM calendar_page_runs").get()!.lock_owner, null);

    fake = reset(); fake.addExisting();
    fake.onCreatedPageDiscovery = () => {
      db!.prepare("UPDATE calendar_page_runs SET lock_owner = ?, lock_until = ? WHERE target_date = ?")
        .run("replacement-process", new Date(Date.now() + 60_000).toISOString(), TARGET);
    };
    await assert.rejects(runHamiltonCalendar(NOW, { wait: async () => {} }), /Calendar page lease was lost/);
    assert.equal(fake.creates.length, 0);
    assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 0,
      "a lease taken over during discovery must stop page and view writes");
    assert.equal(db.prepare("SELECT lock_owner FROM calendar_page_runs").get()!.lock_owner, "replacement-process",
      "finally must preserve the replacement process's lease");

    fake = reset();
    let releaseQuery!: () => void;
    let queryEntered!: () => void;
    const entered = new Promise<void>((resolve) => { queryEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    fake.queryGate = async () => { queryEntered(); await gate; };
    const first = runHamiltonCalendar(NOW, { wait: async () => {} });
    await entered;
    const callCount = fake.calls.length;
    assert.equal((await runHamiltonCalendar(NOW)).status, "locked");
    assert.equal(fake.calls.length, callCount, "locked caller must not touch Notion");
    releaseQuery();
    assert.equal((await first).status, "created");
    assert.equal(fake.creates.length, 1);
    assert.equal(db.prepare("SELECT lock_owner FROM calendar_page_runs").get()!.lock_owner, null);
    console.log("Hamilton calendar tests passed");
  } finally {
    global.fetch = originalFetch;
    closeServiceDatabase?.();
    db?.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
