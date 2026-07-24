import { createHash } from "node:crypto";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3900),
  MOCK_MODE: z.string().optional(),
  DB_PATH: z.string().default("./media-mcp.sqlite"),
  // Any non-empty secret works — it is stretched to a 32-byte AES key via
  // SHA-256 below. This lets a one-click Render deploy use `generateValue`
  // (a random alphanumeric string) with no hex requirement on the operator.
  ENCRYPTION_KEY: z.string().min(1).optional(),
  V3_BASE_URL: z.string().default("https://api.assistable.ai"),
  GHL_BASE_URL: z.string().default("https://services.leadconnectorhq.com"),
  // Optional: falls back to Render's auto-injected RENDER_EXTERNAL_URL, then
  // localhost. This is the base for the analyze_attachment tool URL registered
  // in each tenant's assistant, so it must be the service's real public URL.
  PUBLIC_BASE_URL: z.string().optional(),
  RENDER_EXTERNAL_URL: z.string().optional(),
});

export interface AppConfig {
  port: number; mock: boolean; dbPath: string; encryptionKey: Buffer;
  v3BaseUrl: string; ghlBaseUrl: string; publicBaseUrl: string;
}

export function loadConfig(): AppConfig {
  const e = envSchema.parse(process.env);
  const mock = e.MOCK_MODE === "1" || e.MOCK_MODE === "true";
  // Mock mode may run keyless (dev); anything live requires a real secret.
  const secret = e.ENCRYPTION_KEY ?? (mock ? "mock-mode-development-key" : undefined);
  if (!secret) {
    throw new Error("ENCRYPTION_KEY is required outside MOCK_MODE");
  }
  // SHA-256 stretches any secret to exactly 32 bytes for AES-256-GCM.
  const encryptionKey = createHash("sha256").update(secret).digest();

  const publicBaseUrl =
    e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL ?? "http://localhost:3900";

  return {
    port: e.PORT, mock, dbPath: e.DB_PATH, encryptionKey,
    v3BaseUrl: e.V3_BASE_URL.replace(/\/$/, ""),
    ghlBaseUrl: e.GHL_BASE_URL.replace(/\/$/, ""),
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
  };
}
