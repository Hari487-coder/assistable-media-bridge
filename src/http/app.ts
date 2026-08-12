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
import { createAssetStore } from "../store/assets";
import { createSendLog } from "../store/send-log";
import { createPortalRouter } from "./portal";
import { createToolRouter } from "./tool";

export function buildApp(config: AppConfig) {
  const db = openDb(config.dbPath);
  const tenants = createTenantStore(db, config.encryptionKey);
  const processed = createProcessedStore(db);
  const events = createEventStore(db);
  const mock = config.mock ? createMockState() : null;
  const wakerState = new Map<string, string>();

  const v3For = (v3Key: string, subAccountId?: string) =>
    mock
      ? mock.v3Factory()
      : createV3Client({ baseUrl: config.v3BaseUrl, apiKey: v3Key, subAccountId });
  const ghlFor = (t: Tenant) =>
    mock ? mock.ghlFactory(t) : createGhlClient({ baseUrl: config.ghlBaseUrl, pit: t.ghlPit });
  const providerFor = (t: Tenant) =>
    mock ? mock.providerFactory() : getProvider(t.provider, t.aiKey);
  const mediaFetch = mock ? mock.mediaFetch : undefined;
  // MOCK_MODE runs the whole loop with no network and no credentials, so the
  // address check gets a stub resolver too — otherwise a mock run performs the
  // one real DNS query left in the pipeline and fails wherever DNS is absent.
  const mediaLookup = mock ? mock.mediaLookup : undefined;

  const assets = createAssetStore(db);
  const sendLog = createSendLog(db);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.get("/health", (_req, res) => { res.json({ ok: true, mock: config.mock }); });
  app.use(createToolRouter({
    tenants, processed, events,
    ghlFactory: ghlFor, providerFactory: providerFor, mediaFetch, mediaLookup,
    assets, sendLog,
  }));
  app.use(createMcpRouter({
    tenants, events, providerFactory: providerFor, mediaFetch, mediaLookup,
  }));
  app.use(createPortalRouter({
    tenants, events, assets, publicBaseUrl: config.publicBaseUrl,
    ...(mock ? { assetFetch: mock.assetFetch, assetLookup: mock.mediaLookup } : {}),
    v3Factory: (key, subAccountId) => v3For(key, subAccountId),
    ghlFactory: (pit) =>
      (mock ? mock.ghlFactory() : createGhlClient({ baseUrl: config.ghlBaseUrl, pit })),
    providerFactory: (name, key) => (mock ? mock.providerFactory() : getProvider(name, key)),
  }));

  const wakerDepsFor = (t: Tenant): WakerDeps => ({
    v3: v3For(t.v3Key, t.subAccountId), processed, events, state: wakerState,
    budgetMs: config.wakerBudgetMs,
  });

  return {
    app,
    wireDeps: {
      tenants, processed, events, wakerDepsFor,
      mockV3State: mock ?? {
        wokenConversations: new Set<string>(),
        sentMessages: [] as Array<{ contactId: string; type: string; message?: string; attachments: string[] }>,
        bumpConversation() { /* noop outside mock mode */ },
      },
    },
  };
}
