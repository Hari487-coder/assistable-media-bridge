export interface V3ClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Optional Assistable SubAccount id. Required only for workspace-wide keys
   *  that span multiple subaccounts; a single-subaccount key resolves itself. */
  subAccountId?: string;
  fetchImpl?: typeof fetch;
  /** Per-request ceiling. A hung request is worse than a failed one: it holds a
   *  waker concurrency slot indefinitely and stalls the tenants queued behind
   *  it, with nothing in the event feed to show why. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

// Platform envelope is { data, error, request_id }; lists may be keyed or bare.
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
// Pull the most useful human string out of the v3 error envelope.
function errDetail(status: number, json: unknown): string {
  const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
  if (e && typeof e === "object" && typeof e.message === "string") {
    return `HTTP ${status} (${e.code ?? "error"}: ${e.message})`;
  }
  const s = typeof json === "string" ? json : JSON.stringify(json ?? "");
  return `HTTP ${status}${s ? ` — ${s.slice(0, 150)}` : ""}`;
}

export function createV3Client(opts: V3ClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    // For a workspace-wide key, the subaccount must be named on every request.
    // Header covers GET; we also stamp it into POST bodies as belt-and-suspenders.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
    };
    if (opts.subAccountId) headers["X-Subaccount-Id"] = opts.subAccountId;
    let sendBody = body;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      sendBody = opts.subAccountId ? { subaccount_id: opts.subAccountId, ...body } : body;
    }
    let res: Response;
    try {
      res = await f(`${opts.baseUrl}/${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ...(sendBody !== undefined ? { body: JSON.stringify(sendBody) } : {}),
      });
    } catch (err) {
      // Surface a timeout as a normal call failure so every caller's existing
      // error handling applies — the waker records it and retries next cycle.
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : "network error");
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    const bodyOk = !(json && typeof json === "object" && (json as { ok?: unknown }).ok === false);
    return { ok: res.ok && bodyOk, status: res.status, json };
  };

  return {
    async listConversations(limit: number) {
      const r = await call("GET", `v3/conversations?sort=newest&limit=${limit}`);
      if (!r.ok) throw new Error(`v3 listConversations ${errDetail(r.status, r.json)}`);
      return items(unwrap(r.json)) as Array<{
        id: string; contactId: string | null; updatedAt: string;
        assistant: { id: string; name?: string } | null;
      }>;
    },
    async listMessages(conversationId: string) {
      const r = await call("GET", `v3/conversations/${conversationId}/messages`);
      if (!r.ok) throw new Error(`v3 listMessages ${errDetail(r.status, r.json)}`);
      // `type` is a MessageType (TEXT / IMAGE / AUDIO / FILE / VIDEO / ...).
      // It is what separates "media arrived with no caption" from "the contact
      // tapped a reaction" — both reach us with a null body.
      return items(unwrap(r.json)) as Array<{
        id: string; content: string | null; ai: boolean; source: string;
        channel: string | null; createdAt: string; type?: string | null;
      }>;
    },
    async chatCompletion(a: {
      assistantId: string; conversationId: string; additionalInstructions: string;
    }) {
      const r = await call("POST", "v3/chat/completions", {
        assistant_id: a.assistantId,
        conversation_id: a.conversationId,
        additional_instructions: a.additionalInstructions,
      });
      return r.ok
        ? { ok: true as const }
        : { ok: false as const, error: `v3 chat ${errDetail(r.status, r.json)}` };
    },
    async listAssistants() {
      const r = await call("GET", "v3/assistants?limit=100");
      if (!r.ok) throw new Error(`v3 listAssistants ${errDetail(r.status, r.json)}`);
      return items(unwrap(r.json)) as Array<{ id: string; name: string }>;
    },
    /** Create a CUSTOM (external-webhook) tool. Body is snake_case per the v3 API. */
    async createTool(input: { name: string; description: string; url: string }) {
      const r = await call("POST", "v3/tools", {
        name: input.name,
        description: input.description,
        url: input.url,
        http_method: "POST",
        tool_type: "CUSTOM",
      });
      if (r.status === 409) return { id: null as string | null, conflict: true as const, raw: r.json };
      if (!r.ok) throw new Error(`v3 createTool ${errDetail(r.status, r.json)}`);
      const d = unwrap(r.json) as { id?: string } | null;
      return { id: d?.id ?? null, conflict: false as const, raw: r.json };
    },
    /** Find an existing tool by exact name (for idempotent re-onboarding). */
    async findToolByName(name: string): Promise<string | null> {
      const r = await call("GET", `v3/tools?search=${encodeURIComponent(name)}&limit=100`);
      if (!r.ok) return null;
      const rows = items(unwrap(r.json)) as Array<{ id: string; name: string }>;
      return rows.find((t) => t.name === name)?.id ?? null;
    },
    /** Repoint an existing tool's webhook URL (e.g. a tool created by an older
     *  bridge instance must be re-aimed at THIS instance before reuse). */
    async updateToolUrl(toolId: string, url: string) {
      const r = await call("PATCH", `v3/tools/${toolId}`, { url });
      return r.ok
        ? { ok: true as const }
        : { ok: false as const, error: `v3 updateTool ${errDetail(r.status, r.json)}` };
    },
    /** Attach a tool to an assistant so the assistant can actually call it. */
    async assignTool(toolId: string, assistantId: string) {
      const r = await call("POST", `v3/tools/${toolId}/assign`, { assistant_id: assistantId });
      return r.ok
        ? { ok: true as const }
        : { ok: false as const, error: `v3 assignTool ${errDetail(r.status, r.json)}` };
    },
    /** Validate the key against a real scoped call. Returns a diagnostic detail
     *  so onboarding can tell the user WHY (bad key vs wrong subaccount). */
    async validateKey(): Promise<{ ok: boolean; detail?: string }> {
      try {
        const r = await call("GET", "v3/conversations?sort=newest&limit=1");
        return r.ok ? { ok: true } : { ok: false, detail: errDetail(r.status, r.json) };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "network error" };
      }
    },
  };
}
export type V3Client = ReturnType<typeof createV3Client>;
