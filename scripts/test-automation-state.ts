import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function verifyEditedDailyTaskIndentation() {
  Object.assign(process.env, {
    INTERNAL_ADMIN_TOKEN: "fixture",
    DISCORD_CHANNEL_ID: "fixture-channel",
    NOTION_USER_YOUNGMIN: "fixture-user",
    GCS_API_TOKEN_YOUNGMIN: "fixture-token",
  });
  const database = await import("../src/database");
  const { handleDiscordInteraction } = await import("../src/discord-handler");
  const edited = [
    "**오늘 한 일**",
    "- 상위 업무",
    " - 하위 업무",
    "    - 하위 업무의 하위 항목",
    "  - 이미 들여쓴 하위 업무",
    "- 별도 업무",
    "",
    "**오늘의 배움 또는 남길 말**",
    " - 사용자 메모",
  ].join("\n");
  const expected = edited.replace("\n - 하위 업무\n", "\n  - 하위 업무\n");

  database.createDispatch({
    discordMessageId: "message-edit",
    person: "youngmin",
    snippetType: "daily",
    dateLabel: "11/13",
    content: "**오늘 한 일**\n- 상위 업무\n  - 하위 업무",
    dueAt: "2026-11-14T00:30:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const requests = new Map<string, {
    content?: string;
    embeds?: { description: string }[];
  }>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.body) requests.set(url.pathname, JSON.parse(String(init.body)));
    return new Response();
  };

  try {
    await handleDiscordInteraction(JSON.stringify({
      type: 5,
      data: {
        custom_id: "modal:message-edit",
        components: [
          { components: [{ custom_id: "content", value: edited }] },
          { components: [{ custom_id: "score", value: "7" }] },
        ],
      },
    }));

    const posted = database.getDispatchByMessageId("message-edit");
    assert.equal(posted?.status, "posted");
    assert.equal(posted?.completionSource, "manual-edit");
    assert.equal(
      requests.get("/daily-snippets")?.content,
      `${expected}\n\n헬스 체크 (10점)\n7`
    );
    assert.equal(
      requests.get("/api/v10/channels/fixture-channel/messages/message-edit")?.embeds?.[0]?.description,
      expected
    );
    assert.equal(posted?.content, expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-cron-db-"));
  process.env.SQLITE_DB_PATH = path.join(tempDir, "automation.sqlite");

  const database = await import("../src/database");
  const snippets = await import("../src/snippets");

  const created = database.createDispatch({
    discordMessageId: "message-1",
    person: "youngmin",
    snippetType: "daily",
    dateLabel: "4/24",
    content: "**오늘 한 일**\n- 테스트",
    dueAt: "2026-04-24T00:30:00.000Z",
    createdAt: "2026-04-24T00:00:00.000Z",
  });

  assert.equal(created.status, "pending");
  assert.deepEqual(database.listExistingDispatchPeople("4/24", "daily"), [
    "youngmin",
  ]);

  const claimed = database.claimPendingDispatchByMessageId(
    "message-1",
    "2026-04-24T00:31:00.000Z"
  );
  assert.ok(claimed);
  assert.equal(claimed?.status, "posting");

  database.markDispatchPosted("message-1", {
    content: created.content,
    healthScore: 5,
    completionSource: "auto",
    postedAt: "2026-04-24T00:31:30.000Z",
  });

  const posted = database.getDispatchByMessageId("message-1");
  assert.equal(posted?.status, "posted");
  assert.equal(posted?.healthScore, 5);
  assert.equal(
    snippets.appendHealthCheck("내용", 5),
    "내용\n\n헬스 체크 (10점)\n5"
  );

  database.createDispatch({
    discordMessageId: "message-2",
    person: "youngmin",
    snippetType: "weekly",
    dateLabel: "4/14~4/20",
    content: "초안",
    dueAt: "2026-04-24T00:30:00.000Z",
    createdAt: "2026-04-24T00:00:00.000Z",
  });
  database.claimPendingDispatchByMessageId(
    "message-2",
    "2026-04-24T00:31:00.000Z"
  );
  database.markDispatchFailed("message-2", {
    content: "초안",
    error: "GCS failed",
    failedAt: "2026-04-24T00:31:30.000Z",
  });

  const failed = database.getDispatchByMessageId("message-2");
  assert.equal(failed?.status, "failed");

  const requeued = database.requeueFailedDispatch(
    failed!.id,
    "2026-04-24T00:32:00.000Z"
  );
  assert.equal(requeued?.status, "pending");

  await verifyEditedDailyTaskIndentation();

  database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("automation state tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
