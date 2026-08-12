import { Router } from "express";
import type { GhlClient } from "../clients/ghl";
import { analyzeForContact } from "../core/analyze";
import { sendAssetForContact } from "../core/send";
import type { LookupFn } from "../media/download";
import type { MediaProvider } from "../providers";
import type { EventStore } from "../store/events";
import type { AssetStore } from "../store/assets";
import type { ProcessedStore } from "../store/processed";
import type { SendLog } from "../store/send-log";
import type { Tenant, TenantStore } from "../store/tenants";

export interface ToolRouterCtx {
  tenants: TenantStore; processed: ProcessedStore; events: EventStore;
  ghlFactory: (tenant: Tenant) => GhlClient;
  providerFactory: (tenant: Tenant) => MediaProvider;
  assets: AssetStore;
  sendLog: SendLog;
  mediaFetch?: typeof fetch;
  /** Injected only by tests, so unit runs never perform real DNS. */
  mediaLookup?: LookupFn;
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

/** The model's own arguments live under `args`, but the proxy has been seen to
 *  flatten them onto the body, and models vary between `asset` and
 *  `asset_name`. Accept every shape rather than failing a real send over a key
 *  name the assistant had no way to know. */
function readSendArgs(body: Record<string, unknown>): { asset: string; caption?: string } {
  const args = (body.args && typeof body.args === "object" && !Array.isArray(body.args)
    ? body.args
    : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const src of [args, body]) {
      for (const k of keys) {
        const v = src[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
    return undefined;
  };
  const caption = pick("caption", "message", "text");
  return {
    asset: pick("asset", "asset_name", "assetName", "name") ?? "",
    ...(caption ? { caption } : {}),
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
              lookupImpl: ctx.mediaLookup,
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

  // Outbound half. Serialized on the same key as the read tool: a run that
  // both reads an attachment and sends one must not interleave, or two sends
  // can pass the cooldown check before either records.
  router.post("/send/:token", async (req, res) => {
    try {
      const tenant = ctx.tenants.getByToken(req.params.token);
      if (!tenant) {
        res.status(404).json({ result: "[media sending is not configured for this account]" });
        return;
      }
      if (!tenant.enabled) {
        ctx.events.record(tenant.id, "media_skip", "send called while bridge disabled");
        res.json({ result: "[media sending is disabled for this account]" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { contactId } = readContext(body);
      if (!contactId) {
        ctx.events.record(tenant.id, "media_skip", "no contact context in send envelope");
        res.json({ result: "[no contact context supplied, so nothing was sent]" });
        return;
      }
      const args = readSendArgs(body);
      try {
        const out = await serialized(`${tenant.id}:${contactId}`, () =>
          sendAssetForContact(
            {
              ghl: ctx.ghlFactory(tenant),
              assets: ctx.assets,
              events: ctx.events,
              sendLog: ctx.sendLog,
            },
            tenant, { contactId, ...args }
          )
        );
        res.json({ result: out.text });
      } catch (err) {
        try {
          ctx.events.record(tenant.id, "error", `send: ${err instanceof Error ? err.message : "unknown"}`);
        } catch { /* event store failure must not break the LLM-safe response */ }
        res.json({
          result: "[the media could not be sent right now. The contact did NOT receive it — " +
            "never claim or imply that you sent it.]",
        });
      }
    } catch {
      if (!res.headersSent) {
        res.status(200).json({
          result: "[the media could not be sent right now. The contact did NOT receive it — " +
            "never claim or imply that you sent it.]",
        });
      }
    }
  });
  return router;
}
