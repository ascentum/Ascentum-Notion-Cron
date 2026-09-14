import assert from "node:assert/strict";
import {
  buildCalendarQueryFilter,
  getFirstBlockIdByType,
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

console.log("work calendar linked view filter checks passed");
