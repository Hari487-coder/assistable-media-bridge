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
        Version: "2021-07-28",
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
      // A contact frequently owns SEVERAL conversation threads (per channel /
      // per number, plus GHL's duplicate-thread quirks), and which one search
      // ranks first can flip between calls. Reading only convs[0] made
      // consecutive tool calls see disjoint message sets (observed live:
      // "0 fresh" then "2 fresh" half a second apart). Merge the top threads
      // into one deduped view so every call sees the same reality.
      const errors: string[] = [];
      const merged = new Map<string, { id: string; convId: string; attachments: string[]; direction: string; dateAdded: string }>();
      for (const conv of convs.slice(0, 3)) {
        const msgsRes = await get(`/conversations/${conv.id}/messages`);
        if (!msgsRes.ok) {
          errors.push(`ghl messages ${msgsRes.status} (conv ${conv.id})`);
          continue;
        }
        // GHL nests: { messages: { messages: [...] } } — tolerate both nestings.
        const outer = msgsRes.json?.messages as unknown;
        const list = (Array.isArray(outer)
          ? outer
          : ((outer as { messages?: unknown[] } | null)?.messages ?? [])) as GhlMessage[];
        for (const m of list) {
          if ((m.direction ?? "").toLowerCase() !== "inbound") continue;
          const attachments = asAttachments(m.attachments);
          if (attachments.length === 0) continue;
          if (!merged.has(m.id)) {
            merged.set(m.id, {
              id: m.id, convId: conv.id, attachments,
              direction: m.direction ?? "", dateAdded: m.dateAdded ?? "",
            });
          }
        }
      }
      if (merged.size === 0 && errors.length > 0) throw new Error(errors[0]);
      return [...merged.values()]
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
