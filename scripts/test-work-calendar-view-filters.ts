import assert from "node:assert/strict";
import { replaceLinkedViewDateFilters } from "./fix-work-calendar-linked-view-filters";

const datePropertyKeys = new Set(["HDdB", "완료일"]);

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

console.log("work calendar linked view filter checks passed");
