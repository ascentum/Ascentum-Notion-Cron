import assert from "node:assert/strict";
import {
  buildCalendarQueryFilter,
  getFirstBlockIdByType,
  listLinkedWorkViews,
  queryCalendarPages,
  updateLinkedViewsForPage,
  replaceLinkedViewDateFilters,
} from "./fix-work-calendar-linked-view-filters";

const datePropertyKeys = new Set(["HDdB", "완료일"]);

assert.equal(
  getFirstBlockIdByType(
    [
      { id: "paragraph-1", type: "paragraph" },
      { id: "callout-1", type: "callout" },
      { id: "callout-2", type: "callout" },
    ],
    "callout"
  ),
  "callout-1"
);

const nestedFilter = {
  or: [
    {
      property: "Gbht",
      checkbox: { equals: false },
    },
    {
      and: [
        {
          property: "Gbht",
          checkbox: { equals: true },
        },
        {
          property: "HDdB",
          date: { equals: "today" },
        },
      ],
    },
  ],
};

const quickFilters = {
  HDdB: {
    date: { equals: "today" },
  },
  FMmF: {
    people: { contains: "7ea05b23-6a71-4a66-992a-5683f75e4145" },
  },
};

const replaced = replaceLinkedViewDateFilters(
  {
    filter: nestedFilter,
    quick_filters: quickFilters,
  },
  {
    datePropertyKeys,
    targetDate: "2026-05-15",
    forceDateFilters: false,
  }
);

assert.equal(replaced.changed, true);
assert.deepEqual(replaced.value.filter, {
  or: [
    {
      property: "Gbht",
      checkbox: { equals: false },
    },
    {
      and: [
        {
          property: "Gbht",
          checkbox: { equals: true },
        },
        {
          property: "HDdB",
          date: { equals: "2026-05-15" },
        },
      ],
    },
  ],
});
assert.deepEqual(replaced.value.quick_filters, {
  HDdB: {
    date: { equals: "2026-05-15" },
  },
  FMmF: {
    people: { contains: "7ea05b23-6a71-4a66-992a-5683f75e4145" },
  },
});

const absoluteDate = replaceLinkedViewDateFilters(
  {
    filter: {
      property: "HDdB",
      date: { equals: "2026-05-14" },
    },
    quick_filters: null,
  },
  {
    datePropertyKeys,
    targetDate: "2026-05-15",
    forceDateFilters: false,
  }
);

assert.equal(absoluteDate.changed, false);
assert.deepEqual(absoluteDate.value.filter, {
  property: "HDdB",
  date: { equals: "2026-05-14" },
});

const forcedDate = replaceLinkedViewDateFilters(
  {
    filter: {
      property: "HDdB",
      date: { equals: "2026-05-14" },
    },
    quick_filters: null,
  },
  {
    datePropertyKeys,
    targetDate: "2026-05-15",
    forceDateFilters: true,
  }
);

assert.equal(forcedDate.changed, true);
assert.deepEqual(forcedDate.value.filter, {
  property: "HDdB",
  date: { equals: "2026-05-15" },
});

// 캘린더 페이지 조회는 날짜뿐 아니라 담당자(people)로도 좁혀야 한다.
// 같은 날짜에 담당자만 다른 동일 제목 페이지가 있어 제목만으로는 구분되지 않기 때문.
const calendarFilter = buildCalendarQueryFilter({
  calendarDatePropertyName: "일정",
  calendarPersonPropertyName: "사람",
  calendarPersonId: "7ea05b23-6a71-4a66-992a-5683f75e4145",
  startDate: "2026-09-12",
  endDate: "2026-09-14",
});

assert.deepEqual(calendarFilter, {
  and: [
    { property: "일정", date: { on_or_after: "2026-09-12" } },
    { property: "일정", date: { on_or_before: "2026-09-14" } },
    {
      property: "사람",
      people: { contains: "7ea05b23-6a71-4a66-992a-5683f75e4145" },
    },
  ],
});

const sharedQueryOptions = {
  calendarDatePropertyName: "일정",
  calendarPersonPropertyName: "사람",
  startDate: "2026-09-12",
  endDate: "2026-09-14",
};
const multiPersonFilter = buildCalendarQueryFilter({
  ...sharedQueryOptions,
  calendarPersonIds: ["youngmin", "hamilton", "youngmin"],
});
assert.deepEqual(multiPersonFilter, {
  and: [
    { property: "일정", date: { on_or_after: "2026-09-12" } },
    { property: "일정", date: { on_or_before: "2026-09-14" } },
    { or: [
      { property: "사람", people: { contains: "youngmin" } },
      { property: "사람", people: { contains: "hamilton" } },
    ] },
  ],
});
assert.deepEqual(buildCalendarQueryFilter({
  ...sharedQueryOptions, calendarPersonIds: ["youngmin", "youngmin"],
}), buildCalendarQueryFilter({ ...sharedQueryOptions, calendarPersonId: "youngmin" }));
assert.throws(() => buildCalendarQueryFilter({
  ...sharedQueryOptions, calendarPersonIds: [], calendarPersonId: "youngmin",
}), /non-empty calendar person/);
assert.throws(() => buildCalendarQueryFilter({
  ...sharedQueryOptions, calendarPersonIds: [""],
}), /non-empty calendar person/);

const unrelatedDateFilter = { property: "다른 날짜", date: { equals: "today" } };
const unrelatedFilters = replaceLinkedViewDateFilters({
  filter: { and: [unrelatedDateFilter, { property: "HDdB", date: { equals: "today" } }] },
  quick_filters: { other: { date: { equals: "today" } } },
}, { datePropertyKeys, targetDate: "2026-05-15" });
assert.deepEqual(unrelatedFilters.value.filter, { and: [
  unrelatedDateFilter, { property: "HDdB", date: { equals: "2026-05-15" } },
] });
assert.deepEqual(unrelatedFilters.value.quick_filters, { other: { date: { equals: "today" } } });
assert.deepEqual(nestedFilter.or[1].and?.[1], { property: "HDdB", date: { equals: "today" } });

async function checkTraversalAndPagination() {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.NOTION_API_KEY;
  process.env.NOTION_API_KEY = "test-key";
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  const list = (results: unknown[], next: string | null = null) => ({ results, has_more: next !== null, next_cursor: next });
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v1", "");
    requests.push({ path: path + parsed.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown;
    if (path === "/blocks/page/children") {
      body = parsed.searchParams.has("start_cursor")
        ? list([{ id: "callout-2", type: "callout", has_children: true }])
        : list([{ id: "outside", type: "child_database" }, { id: "callout-1", type: "callout", has_children: true }], "blocks-next");
    } else if (path === "/blocks/callout-1/children") {
      body = list([{ id: "inside", type: "child_database" }, { id: "nested", type: "toggle", has_children: true }]);
    } else if (path === "/blocks/nested/children") {
      body = list([{ id: "deep", type: "child_database" }]);
    } else if (path === "/blocks/callout-2/children") {
      body = list([{ id: "second", type: "child_database" }]);
    } else if (path === "/views") {
      const database = parsed.searchParams.get("database_id");
      body = database === "inside" && !parsed.searchParams.has("start_cursor")
        ? list([{ id: "inside" }], "views-next")
        : list([{ id: database === "inside" ? "unrelated" : database }]);
    } else if (path.startsWith("/views/")) {
      const id = path.slice("/views/".length);
      body = {
        id,
        data_source_id: id === "unrelated" ? "other-source" : "work-source",
        filter: { and: [
          { property: "HDdB", date: { equals: "today" } },
          { property: "Gbht", checkbox: { equals: false } },
          { property: "다른 날짜", date: { equals: "today" } },
          { property: "HDdB", date: { on_or_after: "2026-05-01" } },
        ] },
        quick_filters: {
          HDdB: { date: { equals: "today" } },
          FMmF: { people: { contains: "hamilton" } },
        },
      };
    } else if (path === "/data_sources/calendar/query") {
      body = JSON.parse(String(init?.body)).start_cursor
        ? list([{ id: "hamilton-page" }])
        : list([{ id: "youngmin-page" }], "pages-next");
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const options = { maxBlockDepth: 1, workDataSourceId: "work-source", scope: "first-callout" as const };
    assert.deepEqual((await listLinkedWorkViews("page", options)).map((view) => view.childDatabaseId), ["inside", "deep"]);
    assert.deepEqual((await listLinkedWorkViews("page", { ...options, maxBlockDepth: 0 })).map((view) => view.childDatabaseId), ["inside"]);
    assert.deepEqual((await listLinkedWorkViews("page", { ...options, maxBlockDepth: 2, scope: "all" })).map((view) => view.childDatabaseId), ["outside", "inside", "deep", "second"]);
    const result = await updateLinkedViewsForPage({
      pageId: "page", pageTitle: "어센텀 업무", pageDate: "2026-05-15",
      maxBlockDepth: 1, workDataSourceId: "work-source", datePropertyKeys,
      forceDateFilters: false, dryRun: true,
    });
    assert.equal(result.viewsChecked, 2);
    assert.equal(result.viewsUpdated, 2);
    assert.equal(requests.some((request) => request.method === "PATCH"), false);
    const liveResult = await updateLinkedViewsForPage({
      pageId: "page", pageTitle: "어센텀 업무", pageDate: "2026-05-15",
      maxBlockDepth: 0, workDataSourceId: "work-source", datePropertyKeys,
      forceDateFilters: false, dryRun: false,
    });
    assert.equal(liveResult.viewsChecked, 1);
    assert.equal(liveResult.viewsUpdated, 1);
    assert.deepEqual(requests.filter((request) => request.method === "PATCH"), [{
      path: "/views/inside",
      method: "PATCH",
      body: {
        filter: { and: [
          { property: "HDdB", date: { equals: "2026-05-15" } },
          { property: "Gbht", checkbox: { equals: false } },
          { property: "다른 날짜", date: { equals: "today" } },
          { property: "HDdB", date: { on_or_after: "2026-05-01" } },
        ] },
        quick_filters: {
          HDdB: { date: { equals: "2026-05-15" } },
          FMmF: { people: { contains: "hamilton" } },
        },
      },
    }]);
    assert.deepEqual(liveResult.updates, [{
      pageId: "page", pageTitle: "어센텀 업무", pageDate: "2026-05-15",
      childDatabaseId: "inside", viewId: "inside", viewName: "(unnamed view)",
      changedFields: ["filter", "quick_filters"],
    }]);
    const pages = await queryCalendarPages({
      ...sharedQueryOptions, calendarDataSourceId: "calendar", calendarPersonIds: ["youngmin", "hamilton"],
    });
    assert.deepEqual(pages.map((page) => page.id), ["youngmin-page", "hamilton-page"]);
    const queries = requests.filter((request) => request.path === "/data_sources/calendar/query");
    assert.deepEqual(queries[0].body.filter, multiPersonFilter);
    assert.equal(queries[1].body.start_cursor, "pages-next");
    await assert.rejects(queryCalendarPages({
      ...sharedQueryOptions, calendarDataSourceId: "calendar", calendarPersonIds: [],
    }), /non-empty calendar person/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalApiKey;
  }
}

checkTraversalAndPagination().then(() => {
  console.log("work calendar linked view filter checks passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
