import { Router } from "express";
import type { AppConfig } from "../config";
import type { GhlClient } from "../clients/ghl";
import { analyzeForContact } from "../core/analyze";
import type { MediaProvider } from "../providers";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant, TenantStore } from "../store/tenants";

export interface ToolRouterCtx {
  tenants: TenantStore; processed: ProcessedStore; events: EventStore;
  config: AppConfig;
  ghlFactory: (tenant: Tenant) => GhlClient;
  providerFactory: (tenant: Tenant) => MediaProvider;
  mediaFetch?: typeof fetch;
}

// Envelope per tool-proxy.service.ts: { args, meta_data, metadata, call }.
// meta_data and metadata mirror each other; key casing tolerated both ways.
function readContext(body: Record<string, unknown>): { contactId?: string; locationId?: string } {
  const md = { ...(body.metadata as object ?? {}), ...(body.meta_data as object ?? {}) } as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) { const v = md[k]; if (typeof v === "string" && v) return v; }
    return undefined;
  };
  return {
    contactId: pick("contact_id", "contactId"),
    locationId: pick("location_id", "locationId"),
  };
}

export function createToolRouter(ctx: ToolRouterCtx): Router {
  const router = Router();
  router.post("/tool/:token", async (req, res) => {
    const tenant = ctx.tenants.getByToken(req.params.token);
    if (!tenant) {
      res.status(404).json({ result: "[media reader is not configured for this account]" });
      return;
    }
    if (!tenant.enabled) {
      res.json({ result: "[media reader is disabled]" });
      return;
    }
    const { contactId } = readContext((req.body ?? {}) as Record<string, unknown>);
    if (!contactId) {
      res.json({ result: "[no contact context supplied]" });
      return;
    }
    try {
      const out = await analyzeForContact(
        {
          ghl: ctx.ghlFactory(tenant),
          processed: ctx.processed,
          events: ctx.events,
          provider: ctx.providerFactory(tenant),
          fetchImpl: ctx.mediaFetch,
        },
        tenant, contactId
      );
      res.json({ result: out.text });
    } catch (err) {
      ctx.events.record(tenant.id, "error", `tool: ${err instanceof Error ? err.message : "unknown"}`);
      res.json({ result: "[the attachment could not be read right now]" });
    }
  });
  return router;
}
