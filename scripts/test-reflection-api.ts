import assert from "node:assert/strict";
import http from "node:http";

async function main() {
  const requests: { path: string; method: string; body: any; version: string | undefined }[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : null,
      version: req.headers["notion-version"] as string | undefined });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/databases/db") res.end(JSON.stringify({ data_sources: [{ id: "other" }, { id: "source" }] }));
    else if (req.url === "/v1/data_sources/source/query") res.end(JSON.stringify({ results: [], has_more: false }));
    else if (req.url === "/v1/pages") res.end(JSON.stringify({ id: "created" }));
    else { res.statusCode = 400; res.end(JSON.stringify({ message: "legacy query rejected" })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = require("../src/services/reflection-notion-client");
    assert.equal(typeof api.createReflectionClient, "function", "data-source API adapter must exist");
    const client = await api.createReflectionClient({ databaseId: "db", dataSourceId: "source", token: "fixture",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` });
    await client.dataSources.query({ data_source_id: "source", filter: { property: "날짜", date: { equals: "2026-10-15" } } });
    await client.pages.create({ parent: { type: "data_source_id", data_source_id: "source" }, properties: {} });
    assert.ok(requests.every(r => r.version === "2025-09-03"));
    assert.equal(requests[1].path, "/v1/data_sources/source/query");
    assert.deepEqual(requests[2].body.parent, { type: "data_source_id", data_source_id: "source" });
    await assert.rejects(api.createReflectionClient({ databaseId: "db", dataSourceId: "unrelated", token: "fixture",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` }), /does not belong/);
    await assert.rejects(api.createReflectionClient({ databaseId: "db", dataSourceId: "", token: "fixture" }), /DATA_SOURCE_ID/);
    console.log("reflection data source API tests passed");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
