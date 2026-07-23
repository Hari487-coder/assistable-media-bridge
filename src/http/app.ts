import express from "express";
import type { AppConfig } from "../config";
import { openDb } from "../db";
import { createGhlClient } from "../clients/ghl";
import { createV3Client } from "../clients/v3";
import type { WakerDeps } from "../core/waker";
import { createMockState } from "../mock/fakes";
import { getProvider } from "../providers";
import { createEventStore } from "../store/events";
import { createProcessedStore } from "../store/processed";
import { createTenantStore, type Tenant } from "../store/tenants";
import { createMcpRouter } from "./mcp";
import { createPortalRouter } from "./portal";
import { createToolRouter } from "./tool";

export function buildApp(config: AppConfig) {
  const db = openDb(config.dbPath);
  const tenants = createTenantStore(db, config.encryptionKey);
  const processed = createProcessedStore(db);
  const events = createEventStore(db);
  const mock = config.mock ? createMockState() : null;
  const wakerState = new Map<string, string>();

  const v3For = (v3Key: string) =>
    mock ? mock.v3Factory() : createV3Client({ baseUrl: config.v3BaseUrl, apiKey: v3Key });
  const ghlFor = (t: Tenant) =>
    mock ? (mock.ghlFactory(t) as never) : createGhlClient({ baseUrl: config.ghlBaseUrl, pit: t.ghlPit });
  const providerFor = (t: Tenant) =>
    mock ? mock.providerFactory() : getProvider(t.provider, t.aiKey);
  const mediaFetch = mock ? mock.mediaFetch : undefined;

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.get("/health", (_req, res) => { res.json({ ok: true, mock: config.mock }); });
  app.use(createToolRouter({
    tenants, processed, events,
    ghlFactory: ghlFor, providerFactory: providerFor, mediaFetch,
  }));
  app.use(createMcpRouter({ tenants, providerFactory: providerFor, mediaFetch }));
  app.use(createPortalRouter({
    tenants, events, publicBaseUrl: config.publicBaseUrl,
    v3Factory: (key) => v3For(key) as never,
    ghlFactory: (pit) =>
      (mock ? mock.ghlFactory() : createGhlClient({ baseUrl: config.ghlBaseUrl, pit })) as never,
    providerFactory: (name, key) => (mock ? mock.providerFactory() : getProvider(name, key)),
  }));

  const wakerDepsFor = (t: Tenant): WakerDeps => ({
    v3: v3For(t.v3Key) as never, processed, events, state: wakerState,
  });

  return {
    app,
    wireDeps: {
      tenants, processed, events, wakerDepsFor,
      mockV3State: mock ?? { wokenConversations: new Set<string>(), bumpConversation() { /* noop outside mock mode */ } },
    },
  };
}
