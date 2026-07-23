export interface GhlClientOptions { baseUrl: string; pit: string; fetchImpl?: typeof fetch }

interface GhlMessage {
  id: string; direction?: string; attachments?: unknown; dateAdded?: string;
}

export function createGhlClient(opts: GhlClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const get = async (path: string) => {
    const res = await f(`${opts.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${opts.pit}`,
        Version: "2021-04-15",
        Accept: "application/json",
      },
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* tolerate empty */ }
    return { ok: res.ok, status: res.status, json: json as Record<string, unknown> | null };
  };

  const asAttachments = (a: unknown): string[] =>
    Array.isArray(a) ? a.filter((u): u is string => typeof u === "string" && u.length > 0) : [];

  return {
    async latestMediaMessages(q: { locationId: string; contactId: string; limit?: number }) {
      const search = await get(
        `/conversations/search?locationId=${encodeURIComponent(q.locationId)}&contactId=${encodeURIComponent(q.contactId)}&sortBy=last_message_date&sort=desc`
      );
      if (!search.ok) throw new Error(`ghl conversations/search ${search.status}`);
      // Explicit ordering — do not trust GHL's default sort; spike verifies param names against the live API.
      const rawConvs = search.json?.conversations;
      const convs = (Array.isArray(rawConvs) ? rawConvs : []) as Array<{ id: string }>;
      if (convs.length === 0) return [];
      const msgsRes = await get(`/conversations/${convs[0].id}/messages`);
      if (!msgsRes.ok) throw new Error(`ghl messages ${msgsRes.status}`);
      // GHL nests: { messages: { messages: [...] } } — tolerate both nestings.
      const outer = msgsRes.json?.messages as unknown;
      const list = (Array.isArray(outer)
        ? outer
        : ((outer as { messages?: unknown[] } | null)?.messages ?? [])) as GhlMessage[];
      return list
        .filter((m) => (m.direction ?? "").toLowerCase() === "inbound")
        .map((m) => ({
          id: m.id,
          attachments: asAttachments(m.attachments),
          direction: m.direction ?? "",
          dateAdded: m.dateAdded ?? "",
        }))
        .filter((m) => m.attachments.length > 0)
        .sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))
        .slice(0, q.limit ?? 3);
    },
    async validatePit(locationId: string): Promise<boolean> {
      try {
        const r = await get(`/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=1`);
        return r.ok;
      } catch { return false; }
    },
  };
}
export type GhlClient = ReturnType<typeof createGhlClient>;
