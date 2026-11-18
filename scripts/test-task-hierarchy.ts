import assert from "node:assert/strict";
import {
  formatTaskTreeByUser,
  getPageDate,
  getTaskParentId,
  getTaskTitle,
  getWorkPages,
  buildFormattedTasks,
  notion,
  mapWithConcurrencyLimit,
  type TaskInfo,
} from "../lib/notion";

const USER_IDS = {
  youngmin: "youngmin-user",
  partner: "partner-user",
};

async function verifySnippetCompletionDateScope() {
  const date = "2026-11-18";
  const makePage = (id: string, completedOn: string, parentId?: string, completed = true) => ({
    id,
    properties: {
      이름: { type: "title", title: [{ plain_text: id }] },
      완료: { type: "checkbox", checkbox: completed },
      완료일: { type: "date", date: { start: completedOn } },
      PIC: { type: "people", people: [{ id: USER_IDS.youngmin }] },
      "상위 항목": {
        type: "relation",
        relation: parentId ? [{ id: parentId }] : [],
      },
    },
  });
  const pages = [
    makePage("상위 업무", date),
    makePage("11/17 하위 업무 1", "2026-11-17", "상위 업무"),
    makePage("11/17 하위 업무 2", "2026-11-17", "상위 업무"),
    makePage("11/17 하위 업무 3", "2026-11-17", "상위 업무"),
    makePage("11/18 하위 업무 1", date, "상위 업무"),
    makePage("11/18 하위 업무 2", date, "상위 업무"),
    makePage("11/19 상위 업무", "2026-11-19", undefined, false),
    makePage("미완료 중간 상위 업무", "2026-11-19", "11/19 상위 업무", false),
    makePage("11/18 완료 업무", date, "미완료 중간 상위 업무"),
    makePage("11/19 완료 업무", "2026-11-19", "미완료 중간 상위 업무"),
  ];

  const originalQuery = notion.databases.query;
  const originalRetrieve = notion.pages.retrieve;
  (notion.databases as any).query = async ({ filter }: any) => {
    const results = filter.property === "상위 항목"
      ? pages.filter((page) => getTaskParentId(page) === filter.relation.contains)
      : pages.filter((page) => getPageDate(page) === date && page.properties.완료.checkbox);
    return { results, has_more: false };
  };
  (notion.pages as any).retrieve = async ({ page_id }: { page_id: string }) => {
    const page = pages.find((item) => item.id === page_id);
    assert.ok(page, `unknown fixture page ${page_id}`);
    return page;
  };

  try {
    const workPages = await getWorkPages(date, date);
    assert.equal(workPages.length, 4);
    const formatted = await buildFormattedTasks(workPages, USER_IDS);
    assert.deepEqual(formatted.youngmin, [
      "상위 업무",
      "  - 11/18 하위 업무 1",
      "  - 11/18 하위 업무 2",
      "11/19 상위 업무",
      "  - 미완료 중간 상위 업무",
      "    - 11/18 완료 업무",
    ]);
  } finally {
    notion.databases.query = originalQuery;
    notion.pages.retrieve = originalRetrieve;
  }
}

async function verifyHierarchyFormatting() {
  const tasks: TaskInfo[] = [
    {
      id: "root",
      title: "Root Task",
      category: "Planning",
      parentId: null,
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 0,
    },
    {
      id: "child",
      title: "Child Task",
      category: "Execution",
      parentId: "root",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 1,
    },
    {
      id: "grandchild",
      title: "Grandchild Task",
      category: "QA",
      parentId: "child",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 2,
    },
    {
      id: "context-parent",
      title: "Context Parent",
      category: "Docs",
      parentId: null,
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "context-child",
      title: "Context Child",
      category: "Release",
      parentId: "context-parent",
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "leaf-task",
      title: "Leaf Task",
      category: "Ops",
      parentId: "context-child",
      users: [USER_IDS.partner],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 3,
    },
  ];

  const formatted = formatTaskTreeByUser(tasks, USER_IDS);

  assert.deepEqual(formatted.youngmin, [
    "[Planning] Root Task",
    "  - [Execution] Child Task",
    "    - [QA] Grandchild Task",
  ]);
  assert.deepEqual(formatted.partner, [
    "[Docs] Context Parent",
    "  - [Release] Context Child",
    "    - [Ops] Leaf Task",
  ]);
  assert.equal(
    formatted.youngmin.filter((line) => line.includes("Child Task")).length,
    1
  );
}

async function verifyCompletedExpansionRules() {
  const tasks: TaskInfo[] = [
    {
      id: "root-seed",
      title: "Root Seed",
      category: "Planning",
      parentId: null,
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 0,
    },
    {
      id: "incomplete-parent",
      title: "Incomplete Parent",
      category: "Internal",
      parentId: "root-seed",
      users: [],
      isCompleted: false,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "connected-descendant",
      title: "Connected Descendant",
      category: "QA",
      parentId: "incomplete-parent",
      users: [USER_IDS.partner],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 3,
    },
    {
      id: "out-of-scope-descendant",
      title: "Out of Scope Descendant",
      category: "QA",
      parentId: "root-seed",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "shared-parent",
      title: "Shared Parent",
      category: "Docs",
      parentId: null,
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
    {
      id: "youngmin-seed",
      title: "Youngmin Seed",
      category: "Execution",
      parentId: "shared-parent",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 1,
    },
    {
      id: "partner-sibling-seed",
      title: "Partner Sibling Seed",
      category: "Ops",
      parentId: "shared-parent",
      users: [USER_IDS.partner],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 2,
    },
  ];

  const formatted = formatTaskTreeByUser(tasks, USER_IDS);

  assert.deepEqual(formatted.youngmin, [
    "[Planning] Root Seed",
    "  - [Internal] Incomplete Parent",
    "    - [QA] Connected Descendant",
    "[Docs] Shared Parent",
    "  - [Execution] Youngmin Seed",
  ]);
  assert.deepEqual(formatted.partner, [
    "[Planning] Root Seed",
    "  - [Internal] Incomplete Parent",
    "    - [QA] Connected Descendant",
    "[Docs] Shared Parent",
    "  - [Ops] Partner Sibling Seed",
  ]);
  assert.equal(
    formatted.youngmin.some((line) => line.includes("Partner Sibling Seed")),
    false
  );
  assert.equal(
    formatted.partner.some((line) => line.includes("Youngmin Seed")),
    false
  );
}

async function verifyCycleSafety() {
  const tasks: TaskInfo[] = [
    {
      id: "cycle-a",
      title: "Cycle A",
      category: "Ops",
      parentId: "cycle-b",
      users: [USER_IDS.youngmin],
      isCompleted: true,
      isInScope: true,
      sourceIndex: 0,
    },
    {
      id: "cycle-b",
      title: "Cycle B",
      category: "Ops",
      parentId: "cycle-a",
      users: [],
      isCompleted: true,
      isInScope: false,
      sourceIndex: Number.POSITIVE_INFINITY,
    },
  ];

  const formatted = formatTaskTreeByUser(tasks, USER_IDS);

  assert.deepEqual(formatted.youngmin, [
    "[Ops] Cycle A",
    "  - [Ops] Cycle B",
  ]);
}

async function verifyConcurrencyLimit() {
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrencyLimit(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return value * 2;
    }
  );

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
}

// A renamed or blank Notion title property must survive the complete snippet path.
async function verifyRenamedTaskTitles() {
  const originalQuery = notion.databases.query;
  (notion.databases as any).query = async () => ({ results: [], has_more: false });
  try {
    for (const propertyName of ["", "업무명", "이름"]) {
      const page = {
        id: `renamed-title-${propertyName}`,
        properties: {
          [propertyName]: {
            id: "title", type: "title",
            title: [{ plain_text: "Appstoreconnect " }, { plain_text: "이슈 해결" }],
          },
          카테고리: { type: "select", select: { name: "Archy" } },
          PIC: { type: "people", people: [{ id: USER_IDS.youngmin }] },
          완료: { type: "checkbox", checkbox: true },
          "상위 항목": { type: "relation", relation: [] },
        },
      };
      assert.equal(getTaskTitle(page), "Appstoreconnect 이슈 해결");
      const formatted = await buildFormattedTasks([page], USER_IDS);
      assert.deepEqual(formatted.youngmin, ["[Archy] Appstoreconnect 이슈 해결"]);
      assert.deepEqual(formatted.partner, []);
    }
    assert.equal(getTaskTitle({ properties: {} }), "");
    assert.equal(getTaskTitle({}), "");
    assert.equal(getTaskTitle({ properties: {
      이름: { type: "rich_text", rich_text: [{ plain_text: "Not a title" }] },
      업무: { type: "title", title: [{ plain_text: "실제 업무" }] },
    }}), "실제 업무");
  } finally {
    notion.databases.query = originalQuery;
  }
}

async function main() {
  await verifySnippetCompletionDateScope();
  await verifyRenamedTaskTitles();
  await verifyHierarchyFormatting();
  await verifyCompletedExpansionRules();
  await verifyCycleSafety();
  await verifyConcurrencyLimit();
  console.log("task hierarchy checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
