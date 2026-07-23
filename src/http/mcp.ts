import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import { z } from "zod";
import { downloadMedia } from "../media/download";
import { sniff } from "../media/sniff";
import type { MediaProvider } from "../providers";
import type { Tenant, TenantStore } from "../store/tenants";

export interface McpRouterCtx {
  tenants: TenantStore;
  providerFactory: (tenant: Tenant) => MediaProvider;
  mediaFetch?: typeof fetch;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errText = (t: string) => ({ ...text(t), isError: true });

function buildServer(ctx: McpRouterCtx, tenant: Tenant): McpServer {
  const server = new McpServer({ name: "media-mcp", version: "0.1.0" });
  const provider = ctx.providerFactory(tenant);

  const fetchAndSniff = async (
    url: string
  ): Promise<{ error: string } | { bytes: Uint8Array; sniffed: ReturnType<typeof sniff> }> => {
    const dl = await downloadMedia(url, { fetchImpl: ctx.mediaFetch });
    if ("error" in dl) return { error: `download failed: ${dl.error}` };
    return { bytes: dl.bytes, sniffed: sniff(dl.bytes) };
  };
  const analyze = async (url: string, expectedKind?: "audio" | "image" | "pdf") => {
    const r = await fetchAndSniff(url);
    if ("error" in r) return errText(r.error);
    if (r.sniffed.kind === "unknown") return errText("unsupported media type");
    if (expectedKind && r.sniffed.kind !== expectedKind)
      return errText(`expected ${expectedKind}, got ${r.sniffed.kind}`);
    // Honor the same per-tenant modality kill switches as the tool/waker path
    // (analyze.ts) — a disabled modality must not process on any door.
    if (r.sniffed.kind === "audio" && !tenant.modalities.audio)
      return errText("[audio processing is disabled for this account]");
    if (r.sniffed.kind === "image" && !tenant.modalities.image)
      return errText("[image processing is disabled for this account]");
    try {
      return text(await provider.describe({ kind: r.sniffed.kind, mime: r.sniffed.mime, bytes: r.bytes }));
    } catch (err) {
      return errText(err instanceof Error ? err.message : "provider error");
    }
  };

  server.registerTool("analyze_attachment",
    { description: "Read any media attachment (voice note, image, or document) by URL and return its content as text.",
      inputSchema: { url: z.string().url() } },
    async ({ url }) => analyze(url));
  server.registerTool("transcribe_audio",
    { description: "Transcribe an audio file or voice note by URL.",
      inputSchema: { url: z.string().url() } },
    async ({ url }) => analyze(url, "audio"));
  server.registerTool("analyze_image",
    { description: "Describe an image and extract its text (OCR) by URL.",
      inputSchema: { url: z.string().url() } },
    async ({ url }) => analyze(url, "image"));
  server.registerTool("read_document",
    { description: "Extract the text of a PDF document by URL.",
      inputSchema: { url: z.string().url() } },
    async ({ url }) => analyze(url, "pdf"));
  server.registerTool("status",
    { description: "Show this account's media configuration.", inputSchema: {} },
    async () => text(JSON.stringify({
      label: tenant.label, provider: tenant.provider,
      modalities: tenant.modalities, wakerEnabled: tenant.wakerEnabled,
    })));
  return server;
}

export function createMcpRouter(ctx: McpRouterCtx): Router {
  const router = Router();
  router.post("/mcp/:token", async (req, res) => {
    try {
      const tenant = ctx.tenants.getByToken(req.params.token);
      if (!tenant || !tenant.enabled) { res.status(401).json({ error: "unknown or disabled token" }); return; }
      // Stateless: fresh server + transport per request (SDK-documented pattern).
      const server = buildServer(ctx, tenant);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void transport.close();
        void server.close();
      };
      res.on("finish", cleanup);
      res.on("close", cleanup);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      // Never surface a 500 — return a valid JSON-RPC error envelope instead.
      if (!res.headersSent) {
        res.status(200).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } });
      }
    }
  });
  return router;
}
