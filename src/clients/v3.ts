export interface V3ClientOptions {
  baseUrl: string; apiKey: string; fetchImpl?: typeof fetch;
}

// Platform envelope may be {ok,data} or bare; lists may be keyed or bare arrays.
function unwrap(json: unknown): unknown {
  const j = json as { data?: unknown } | null;
  return j && typeof j === "object" && "data" in j ? j.data : json;
}
function items(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  const o = (x ?? {}) as Record<string, unknown>;
  for (const k of ["items", "conversations", "messages", "assistants", "tools"]) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

export function createV3Client(opts: V3ClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${opts.baseUrl}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    const bodyOk = !(json && typeof json === "object" && (json as { ok?: unknown }).ok === false);
    return { ok: res.ok && bodyOk, status: res.status, json };
  };

  return {
    async listConversations(limit: number) {
      const r = await call("GET", `api/v3/conversations?sort=newest&limit=${limit}`);
      if (!r.ok) throw new Error(`v3 listConversations ${r.status}`);
      return items(unwrap(r.json)) as Array<{
        id: string; contactId: string | null; updatedAt: string;
        assistant: { id: string; name?: string } | null;
      }>;
    },
    async listMessages(conversationId: string) {
      const r = await call("GET", `api/v3/conversations/${conversationId}/messages`);
      if (!r.ok) throw new Error(`v3 listMessages ${r.status}`);
      return items(unwrap(r.json)) as Array<{
        id: string; content: string | null; ai: boolean; source: string;
        channel: string | null; createdAt: string;
      }>;
    },
    async chatCompletion(a: {
      assistantId: string; conversationId: string; additionalInstructions: string;
    }) {
      const r = await call("POST", "api/v3/chat/completions", {
        assistant_id: a.assistantId,
        conversation_id: a.conversationId,
        additional_instructions: a.additionalInstructions,
      });
      return r.ok ? { ok: true as const } : { ok: false as const, error: `v3 chat ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}` };
    },
    async listAssistants() {
      const r = await call("GET", "api/v3/assistants?limit=100");
      if (!r.ok) throw new Error(`v3 listAssistants ${r.status}`);
      return items(unwrap(r.json)) as Array<{ id: string; name: string }>;
    },
    async createTool(input: { name: string; description: string; url: string; httpMethod: "POST" }) {
      const r = await call("POST", "api/v3/tools", input);
      if (!r.ok) throw new Error(`v3 createTool ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
      const d = unwrap(r.json) as { id?: string } | null;
      return { id: d?.id ?? null, raw: r.json };
    },
    async validateKey(): Promise<boolean> {
      try {
        const r = await call("GET", "api/v3/conversations?sort=newest&limit=1");
        return r.ok;
      } catch { return false; }
    },
  };
}
export type V3Client = ReturnType<typeof createV3Client>;
