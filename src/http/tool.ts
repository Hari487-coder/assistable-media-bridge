import { Router } from "express";
import type { GhlClient } from "../clients/ghl";
import { analyzeForContact } from "../core/analyze";
import type { MediaProvider } from "../providers";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant, TenantStore } from "../store/tenants";

export interface ToolRouterCtx {
  tenants: TenantStore; processed: ProcessedStore; events: EventStore;
  ghlFactory: (tenant: Tenant) => GhlClient;
  providerFactory: (tenant: Tenant) => MediaProvider;
  mediaFetch?: typeof fetch;
}

// Envelope per tool-proxy.service.ts: { args, meta_data, metadata, call }.
// meta_data takes full precedence over metadata (checked source-by-source,
// both key casings per source); non-object sources are ignored.
function readContext(body: Record<string, unknown>): { contactId?: string; locationId?: string } {
  const sources = [body.meta_data, body.metadata].filter(
    (s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s)
  );
  const pick = (...keys: string[]) => {
    for (const src of sources) {
      for (const k of keys) {
        const v = src[k];
        if (typeof v === "string" && v) return v;
      }
    }
    return undefined;
  };
  return {
    contactId: pick("contact_id", "contactId"),
    locationId: pick("location_id", "locationId"),
  };
}

export function createToolRouter(ctx: ToolRouterCtx): Router {
  const router = Router();
  // The assistant fires analyze_attachment several times per run (and runs can
  // overlap), so unserialized calls race: both read GHL before either marks,
  // and the same attachment gets downloaded and billed to Gemini twice.
  // Serialize per tenant+contact; the queue entry is removed when its chain
  // drains so the map cannot grow unboundedly.
  const inFlight = new Map<string, Promise<void>>();
  const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = inFlight.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    const link = run.then(() => undefined, () => undefined); // failures never break the chain
    inFlight.set(key, link);
    void link.then(() => {
      if (inFlight.get(key) === link) inFlight.delete(key);
    });
    return run;
  };
  router.post("/tool/:token", async (req, res) => {
    try {
      const tenant = ctx.tenants.getByToken(req.params.token);
      if (!tenant) {
        res.status(404).json({ result: "[media reader is not configured for this account]" });
        return;
      }
      if (!tenant.enabled) {
        ctx.events.record(tenant.id, "tool_skip", "tool called while bridge disabled");
        res.json({ result: "[media reader is disabled]" });
        return;
      }
      const { contactId } = readContext((req.body ?? {}) as Record<string, unknown>);
      if (!contactId) {
        ctx.events.record(tenant.id, "tool_skip", "no contact context in tool call envelope");
        res.json({ result: "[no contact context supplied]" });
        return;
      }
      try {
        const out = await serialized(`${tenant.id}:${contactId}`, () =>
          analyzeForContact(
            {
              ghl: ctx.ghlFactory(tenant),
              processed: ctx.processed,
              events: ctx.events,
              provider: ctx.providerFactory(tenant),
              fetchImpl: ctx.mediaFetch,
            },
            tenant, contactId
          )
        );
        res.json({ result: out.text });
      } catch (err) {
        try {
          ctx.events.record(tenant.id, "error", `tool: ${err instanceof Error ? err.message : "unknown"}`);
        } catch { /* event store failure must not break the LLM-safe response */ }
        res.json({ result: "[the attachment could not be read right now]" });
      }
    } catch {
      // Absolute last resort — the assistant must never see a 500.
      if (!res.headersSent) {
        res.status(200).json({ result: "[the attachment could not be read right now]" });
      }
    }
  });
  return router;
}
