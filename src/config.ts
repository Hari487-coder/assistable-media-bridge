import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3900),
  MOCK_MODE: z.string().optional(),
  DB_PATH: z.string().default("./media-mcp.sqlite"),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  V3_BASE_URL: z.string().default("https://app.assistable.ai"),
  GHL_BASE_URL: z.string().default("https://services.leadconnectorhq.com"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3900"),
});

export interface AppConfig {
  port: number; mock: boolean; dbPath: string; encryptionKey: Buffer;
  v3BaseUrl: string; ghlBaseUrl: string; publicBaseUrl: string;
}

export function loadConfig(): AppConfig {
  const e = envSchema.parse(process.env);
  const mock = e.MOCK_MODE === "1" || e.MOCK_MODE === "true";
  // Mock mode may run keyless (dev); anything live requires the real key.
  const keyHex = e.ENCRYPTION_KEY ?? (mock ? "00".repeat(32) : undefined);
  if (!keyHex) throw new Error("ENCRYPTION_KEY (64 hex chars) is required outside MOCK_MODE");
  return {
    port: e.PORT, mock, dbPath: e.DB_PATH,
    encryptionKey: Buffer.from(keyHex, "hex"),
    v3BaseUrl: e.V3_BASE_URL.replace(/\/$/, ""),
    ghlBaseUrl: e.GHL_BASE_URL.replace(/\/$/, ""),
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ""),
  };
}
