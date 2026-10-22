import type {
  QueryDatabaseParameters, QueryDatabaseResponse, CreatePageParameters, CreatePageResponse,
  GetPageResponse, ListBlockChildrenResponse,
} from "@notionhq/client/build/src/api-endpoints";

export interface ReflectionClient {
  dataSources: { query(input: Omit<QueryDatabaseParameters, "database_id"> & { data_source_id: string }): Promise<QueryDatabaseResponse> };
  pages: {
    retrieve(input: { page_id: string }): Promise<GetPageResponse>;
    create(input: Omit<CreatePageParameters, "parent"> & { parent: { type: "data_source_id"; data_source_id: string } }): Promise<CreatePageResponse>;
  };
  blocks: { children: { list(input: { block_id: string; page_size: number; start_cursor?: string }): Promise<ListBlockChildrenResponse> } };
}

// No automatic POST retries: a lost response can still have created a page.
export function notionReflectionRequest(token: string, baseUrl = "https://api.notion.com/v1") {
  return async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Do not include response bodies, tokens or user content in alerts/logs.
      throw new Error(`Notion reflection request failed: HTTP ${response.status} (${path})`);
    }
    return response.json() as Promise<T>;
  };
}

export async function createReflectionClient(options: {
  databaseId: string; dataSourceId: string; token: string; baseUrl?: string;
}): Promise<ReflectionClient> {
  if (!options.dataSourceId) throw new Error("Missing NOTION_REFLECTION_DATA_SOURCE_ID");
  if (!options.token) throw new Error("Missing NOTION_API_KEY");
  const request = notionReflectionRequest(options.token, options.baseUrl);
  const database = await request<{ data_sources: { id: string }[] }>(`/databases/${options.databaseId}`);
  const normalized = (id: string) => id.replaceAll("-", "");
  if (!database.data_sources?.some(source => normalized(source.id) === normalized(options.dataSourceId))) {
    throw new Error("Configured reflection data source does not belong to the reflection database");
  }
  return {
    dataSources: { query: ({ data_source_id, ...body }) => request(`/data_sources/${data_source_id}/query`, body) },
    pages: { retrieve: ({ page_id }) => request(`/pages/${page_id}`), create: body => request("/pages", body) },
    blocks: { children: { list: ({ block_id, ...params }) => {
      const query = new URLSearchParams({ page_size: String(params.page_size) });
      if (params.start_cursor) query.set("start_cursor", params.start_cursor);
      return request(`/blocks/${block_id}/children?${query}`);
    } } },
  };
}
