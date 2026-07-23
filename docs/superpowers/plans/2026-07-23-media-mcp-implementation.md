# Media MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Media MCP service — assistants understand voice notes and images on every GHL channel via one processing core with three doors (Custom Tool, media-only Waker, MCP server).

**Architecture:** Single Node/TypeScript service. A processing core (locate media via GHL → download+sniff → BYO-key provider → text) is exposed through: (1) an HTTP endpoint receiving Assistable CUSTOM-tool envelope calls, (2) a per-tenant polling waker that detects media-only messages via the v3 API and wakes the assistant with `additional_instructions` telling it to call the tool, (3) a Streamable-HTTP MCP server. Portal onboards tenants with 3 validated pastes and auto-creates the tool via the v3 API. Everything runs in MOCK mode without real credentials.

**Tech Stack:** Node 25 (installed: 25.6.1), TypeScript (strict), Express 4, `node:sqlite` (built-in — better-sqlite3 was dropped 2026-07-23: no prebuilt binary for Node 25 + no VS build tools on this machine), zod, @modelcontextprotocol/sdk, vitest + supertest. Native `fetch` everywhere; every client takes an injectable `fetchImpl` for tests.

## Global Constraints

- Strict BYO AI key — the service NEVER holds provider costs; no platform key fallback anywhere.
- No Assistable platform-repo changes; integrate only via public v3 API (`Authorization: Bearer <key>`, base `https://app.assistable.ai`, paths `api/v3/...`) and GHL API (PIT bearer, `Version: 2021-04-15`, base `https://services.leadconnectorhq.com`).
- Privacy: media bytes and transcripts are processed in memory only — never written to disk, DB, or logs. Log metadata only (ids, sizes, durations, error codes).
- Secrets (v3 keys, PITs, provider keys) AES-256-GCM encrypted at rest; master key from env `ENCRYPTION_KEY` (64 hex chars).
- Injected wake instructions always start with the marker `[media-mcp]`.
- External API response shapes are normalized defensively (`unwrap()` pattern) — the platform envelope may be `{ok,data}` or bare; never crash on shape drift.
- MOCK mode (`MOCK_MODE=1`): all three external surfaces (v3, GHL, providers) served by in-process fakes; full E2E must pass in MOCK mode with zero credentials.
- TDD throughout; commit after every green test cycle.

---

### Task 1: Scaffold, config, crypto

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/crypto.ts`
- Test: `test/config.test.ts`, `test/crypto.test.ts`

**Interfaces:**
- Produces: `loadConfig(): AppConfig` — `{ port: number; mock: boolean; dbPath: string; encryptionKey: Buffer; v3BaseUrl: string; ghlBaseUrl: string; publicBaseUrl: string }`
- Produces: `encryptSecret(plain: string, key: Buffer): string` (format `iv:tag:cipher` base64) and `decryptSecret(enc: string, key: Buffer): string`

- [ ] **Step 1: Scaffold**

```bash
cd "C:\Users\Hari Prathap\Downloads\Case Study\assistable-media-bridge"
npm init -y
npm i express zod @modelcontextprotocol/sdk
npm i -D typescript tsx vitest supertest @types/express @types/node @types/supertest
```

`package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "spike": "tsx src/spike.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "outDir": "dist", "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`.gitignore`: `node_modules/`, `dist/`, `.env`, `*.sqlite`
`.env.example`:

```
PORT=3900
MOCK_MODE=1
DB_PATH=./media-mcp.sqlite
ENCRYPTION_KEY=<64 hex chars — openssl rand -hex 32>
V3_BASE_URL=https://app.assistable.ai
GHL_BASE_URL=https://services.leadconnectorhq.com
PUBLIC_BASE_URL=http://localhost:3900
```

- [ ] **Step 2: Write failing tests**

`test/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";

const key = Buffer.alloc(32, 7);

describe("crypto", () => {
  it("round-trips a secret", () => {
    const enc = encryptSecret("sk-test-123", key);
    expect(enc).not.toContain("sk-test-123");
    expect(decryptSecret(enc, key)).toBe("sk-test-123");
  });
  it("produces distinct ciphertexts per call (fresh IV)", () => {
    expect(encryptSecret("a", key)).not.toBe(encryptSecret("a", key));
  });
  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("secret", key);
    const parts = enc.split(":");
    parts[2] = Buffer.from("tampered!").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
  });
});
```

`test/config.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("config", () => {
  it("loads with defaults in mock mode", () => {
    process.env.MOCK_MODE = "1";
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    const c = loadConfig();
    expect(c.mock).toBe(true);
    expect(c.v3BaseUrl).toBe("https://app.assistable.ai");
    expect(c.encryptionKey.length).toBe(32);
  });
  it("throws on missing encryption key outside mock mode", () => {
    process.env.MOCK_MODE = "0";
    delete process.env.ENCRYPTION_KEY;
    expect(() => loadConfig()).toThrow(/ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 3: Run tests, verify failure** — `npm test` → FAIL (modules not found).

- [ ] **Step 4: Implement**

`src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Format: base64(iv):base64(authTag):base64(ciphertext)
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [iv, tag, data] = encoded.split(":").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
```

`src/config.ts`:

```ts
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
```

- [ ] **Step 5: Run tests green, typecheck, commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat: scaffold, config, aes-256-gcm secret crypto"
```

---

### Task 2: SQLite stores (tenants, processed-set, health events)

**Files:**
- Create: `src/db.ts`, `src/store/tenants.ts`, `src/store/processed.ts`, `src/store/events.ts`
- Test: `test/stores.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Database` (better-sqlite3, WAL, schema applied idempotently)
- Produces: `TenantStore` — `create(input: TenantInput): Tenant`, `getByToken(token: string): Tenant | null`, `getByLocationId(locationId: string): Tenant | null`, `list(): Tenant[]`, `setEnabled(id, on)`, `setToolId(id, toolId)`, `setWaker(id, on)`. (A general `update(id, patch)` was deliberately dropped 2026-07-23 — no MVP consumer; YAGNI.) `Tenant = { id: string; token: string; label: string; locationId: string; assistantId: string; provider: "gemini" | "openai"; v3Key: string; ghlPit: string; aiKey: string; wakerEnabled: boolean; toolId: string | null; enabled: boolean; modalities: { audio: boolean; image: boolean } }` — secrets decrypted on read, encrypted on write.
- Produces: `ProcessedStore` — `has(tenantId, messageId): boolean`, `add(tenantId, messageId): void`, `prune(maxAgeMs): number`
- Produces: `EventStore` — `record(tenantId, kind: string, detail: string): void`, `latest(tenantId, limit): EventRow[]` (`kind` ∈ poll|detect|wake|tool_call|error|validate)

- [ ] **Step 1: Write failing tests**

`test/stores.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { createProcessedStore } from "../src/store/processed";
import { createEventStore } from "../src/store/events";

const key = Buffer.alloc(32, 9);
const mk = () => {
  const db = openDb(":memory:");
  return {
    tenants: createTenantStore(db, key),
    processed: createProcessedStore(db),
    events: createEventStore(db),
    db,
  };
};

const input = {
  label: "Volunteer 1", locationId: "loc_1", assistantId: "asst_1",
  provider: "gemini" as const, v3Key: "v3k", ghlPit: "pit", aiKey: "gk",
};

describe("tenant store", () => {
  it("creates and reads back with decrypted secrets", () => {
    const { tenants, db } = mk();
    const t = tenants.create(input);
    expect(t.token).toMatch(/^[a-f0-9]{48}$/);
    expect(tenants.getByToken(t.token)?.aiKey).toBe("gk");
    expect(tenants.getByLocationId("loc_1")?.v3Key).toBe("v3k");
    // Secrets are NOT plaintext at rest
    const raw = db.prepare("SELECT v3_key_enc FROM tenants").get() as { v3_key_enc: string };
    expect(raw.v3_key_enc).not.toContain("v3k");
  });
  it("toggles enabled", () => {
    const { tenants } = mk();
    const t = tenants.create(input);
    tenants.setEnabled(t.id, false);
    expect(tenants.getByToken(t.token)?.enabled).toBe(false);
  });
});

describe("processed store", () => {
  it("dedupes and prunes", () => {
    const { processed } = mk();
    expect(processed.has("t1", "m1")).toBe(false);
    processed.add("t1", "m1");
    expect(processed.has("t1", "m1")).toBe(true);
    expect(processed.has("t2", "m1")).toBe(false);
    expect(processed.prune(-1)).toBe(1); // everything is older than "now - (-1ms)"
    expect(processed.has("t1", "m1")).toBe(false);
  });
});

describe("event store", () => {
  it("records and lists newest first", () => {
    const { events } = mk();
    events.record("t1", "poll", "ok");
    events.record("t1", "detect", "msg m9");
    const rows = events.latest("t1", 10);
    expect(rows[0].kind).toBe("detect");
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `npm test`

- [ ] **Step 3: Implement**

`src/db.ts` (uses Node's built-in `node:sqlite` — same `.prepare().get/.all/.run` call shapes as better-sqlite3):

```ts
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
      location_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
      provider TEXT NOT NULL, v3_key_enc TEXT NOT NULL,
      ghl_pit_enc TEXT NOT NULL, ai_key_enc TEXT NOT NULL,
      waker_enabled INTEGER NOT NULL DEFAULT 1,
      tool_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      audio_on INTEGER NOT NULL DEFAULT 1, image_on INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed (
      tenant_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id, id DESC);
  `);
  return db;
}
```

`src/store/tenants.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db";
import { decryptSecret, encryptSecret } from "../crypto";

export interface TenantInput {
  label: string; locationId: string; assistantId: string;
  provider: "gemini" | "openai"; v3Key: string; ghlPit: string; aiKey: string;
}
export interface Tenant extends TenantInput {
  id: string; token: string; wakerEnabled: boolean; toolId: string | null;
  enabled: boolean; modalities: { audio: boolean; image: boolean };
}

type Row = {
  id: string; token: string; label: string; location_id: string;
  assistant_id: string; provider: string; v3_key_enc: string;
  ghl_pit_enc: string; ai_key_enc: string; waker_enabled: number;
  tool_id: string | null; enabled: number; audio_on: number; image_on: number;
};

export function createTenantStore(db: Db, key: Buffer) {
  const toTenant = (r: Row): Tenant => ({
    id: r.id, token: r.token, label: r.label, locationId: r.location_id,
    assistantId: r.assistant_id, provider: r.provider as Tenant["provider"],
    v3Key: decryptSecret(r.v3_key_enc, key),
    ghlPit: decryptSecret(r.ghl_pit_enc, key),
    aiKey: decryptSecret(r.ai_key_enc, key),
    wakerEnabled: r.waker_enabled === 1, toolId: r.tool_id,
    enabled: r.enabled === 1,
    modalities: { audio: r.audio_on === 1, image: r.image_on === 1 },
  });
  const get = (sql: string, ...args: unknown[]): Tenant | null => {
    const r = db.prepare(sql).get(...args) as Row | undefined;
    return r ? toTenant(r) : null;
  };
  return {
    create(input: TenantInput): Tenant {
      const id = randomUUID();
      const token = randomBytes(24).toString("hex");
      db.prepare(`INSERT INTO tenants
        (id, token, label, location_id, assistant_id, provider,
         v3_key_enc, ghl_pit_enc, ai_key_enc, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, token, input.label, input.locationId, input.assistantId,
          input.provider, encryptSecret(input.v3Key, key),
          encryptSecret(input.ghlPit, key), encryptSecret(input.aiKey, key),
          Date.now());
      const t = get("SELECT * FROM tenants WHERE id = ?", id);
      if (!t) throw new Error("tenant insert failed");
      return t;
    },
    getByToken: (token: string) => get("SELECT * FROM tenants WHERE token = ?", token),
    getByLocationId: (loc: string) => get("SELECT * FROM tenants WHERE location_id = ?", loc),
    list(): Tenant[] {
      return (db.prepare("SELECT * FROM tenants").all() as Row[]).map(toTenant);
    },
    setEnabled(id: string, on: boolean) {
      db.prepare("UPDATE tenants SET enabled = ? WHERE id = ?").run(on ? 1 : 0, id);
    },
    setToolId(id: string, toolId: string) {
      db.prepare("UPDATE tenants SET tool_id = ? WHERE id = ?").run(toolId, id);
    },
    setWaker(id: string, on: boolean) {
      db.prepare("UPDATE tenants SET waker_enabled = ? WHERE id = ?").run(on ? 1 : 0, id);
    },
  };
}
export type TenantStore = ReturnType<typeof createTenantStore>;
```

`src/store/processed.ts`:

```ts
import type { Db } from "../db";

export function createProcessedStore(db: Db) {
  return {
    has(tenantId: string, messageId: string): boolean {
      return !!db.prepare(
        "SELECT 1 FROM processed WHERE tenant_id = ? AND message_id = ?"
      ).get(tenantId, messageId);
    },
    add(tenantId: string, messageId: string): void {
      db.prepare(
        "INSERT OR IGNORE INTO processed (tenant_id, message_id, at) VALUES (?,?,?)"
      ).run(tenantId, messageId, Date.now());
    },
    prune(maxAgeMs: number): number {
      return db.prepare("DELETE FROM processed WHERE at < ?")
        .run(Date.now() - maxAgeMs).changes;
    },
  };
}
export type ProcessedStore = ReturnType<typeof createProcessedStore>;
```

`src/store/events.ts`:

```ts
import type { Db } from "../db";

export interface EventRow { kind: string; detail: string; at: number }

export function createEventStore(db: Db) {
  return {
    record(tenantId: string, kind: string, detail: string): void {
      db.prepare("INSERT INTO events (tenant_id, kind, detail, at) VALUES (?,?,?,?)")
        .run(tenantId, kind, detail, Date.now());
    },
    latest(tenantId: string, limit: number): EventRow[] {
      return db.prepare(
        "SELECT kind, detail, at FROM events WHERE tenant_id = ? ORDER BY id DESC LIMIT ?"
      ).all(tenantId, limit) as EventRow[];
    },
  };
}
export type EventStore = ReturnType<typeof createEventStore>;
```

- [ ] **Step 4: Run tests green** — `npm test`
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sqlite stores — tenants (encrypted), processed-set, events"`

---

### Task 3: Assistable v3 client

**Files:**
- Create: `src/clients/v3.ts`
- Test: `test/v3.test.ts`

**Interfaces:**
- Produces: `createV3Client({ baseUrl, apiKey, fetchImpl? })` with:
  - `listConversations(limit): Promise<Array<{ id: string; contactId: string | null; updatedAt: string; assistant: { id: string } | null }>>` (GET `api/v3/conversations?sort=newest&limit=N`)
  - `listMessages(conversationId): Promise<Array<{ id: string; content: string | null; ai: boolean; source: string; channel: string | null; createdAt: string }>>` (GET `api/v3/conversations/:id/messages`)
  - `chatCompletion({ assistantId, conversationId, additionalInstructions }): Promise<{ ok: boolean; error?: string }>` (POST `api/v3/chat/completions` body `{ assistant_id, conversation_id, additional_instructions }`)
  - `listAssistants(): Promise<Array<{ id: string; name: string }>>`
  - `createTool(input: { name: string; description: string; url: string; httpMethod: "POST" }): Promise<{ id: string | null; raw: unknown }>` (POST `api/v3/tools`)
  - `validateKey(): Promise<boolean>` (listConversations limit 1)
- All responses pass through `unwrap()`: `json?.data ?? json`, then `items` array from `x.items ?? x.conversations ?? x.messages ?? x.assistants ?? (Array.isArray(x) ? x : [])`.

- [ ] **Step 1: Write failing tests**

`test/v3.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createV3Client } from "../src/clients/v3";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const { status = 200, body } = hit ? hit[1] : { status: 404, body: { error: "nf" } };
    return new Response(JSON.stringify(body), { status });
  };
  return { impl: impl as typeof fetch, calls };
}

describe("v3 client", () => {
  it("lists conversations through the {ok,data,items} envelope", async () => {
    const { impl, calls } = fakeFetch({
      "api/v3/conversations?": { body: { ok: true, data: { items: [
        { id: "c1", contactId: "ct1", updatedAt: "2026-07-23T00:00:00Z", assistant: { id: "a1", name: "Bot" } },
      ] } } },
    });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const rows = await v3.listConversations(10);
    expect(rows[0].id).toBe("c1");
    expect(calls[0].url).toContain("sort=newest");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer K");
  });
  it("tolerates a bare-array body", async () => {
    const { impl } = fakeFetch({ "messages": { body: [
      { id: "m1", content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t" },
    ] } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const msgs = await v3.listMessages("c1");
    expect(msgs[0].source).toBe("USER");
  });
  it("posts chat completions with snake_case body", async () => {
    const { impl, calls } = fakeFetch({ "chat/completions": { body: { ok: true, data: {} } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "K", fetchImpl: impl });
    const res = await v3.chatCompletion({
      assistantId: "a1", conversationId: "c1", additionalInstructions: "[media-mcp] hi",
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      assistant_id: "a1", conversation_id: "c1", additional_instructions: "[media-mcp] hi",
    });
  });
  it("validateKey false on 401", async () => {
    const { impl } = fakeFetch({ "api/v3/conversations?": { status: 401, body: { error: "unauthorized" } } });
    const v3 = createV3Client({ baseUrl: "https://x", apiKey: "bad", fetchImpl: impl });
    expect(await v3.validateKey()).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/clients/v3.ts`:

```ts
export interface V3ClientOptions {
  baseUrl: string; apiKey: string; fetchImpl?: typeof fetch;
}

// Platform envelope may be {ok,data} or bare; lists may be keyed or bare arrays.
function unwrap(json: unknown): unknown {
  const j = json as { data?: unknown } | null;
  return j && typeof j === "object" && "data" in j ? j.data : json;
}
function items(x: unknown): unknown[] {
  if (Array.isArray(x)) return x;
  const o = (x ?? {}) as Record<string, unknown>;
  for (const k of ["items", "conversations", "messages", "assistants", "tools"]) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

export function createV3Client(opts: V3ClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${opts.baseUrl}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON error body */ }
    return { ok: res.ok, status: res.status, json };
  };

  return {
    async listConversations(limit: number) {
      const r = await call("GET", `api/v3/conversations?sort=newest&limit=${limit}`);
      if (!r.ok) throw new Error(`v3 listConversations ${r.status}`);
      return items(unwrap(r.json)) as Array<{
        id: string; contactId: string | null; updatedAt: string;
        assistant: { id: string; name?: string } | null;
      }>;
    },
    async listMessages(conversationId: string) {
      const r = await call("GET", `api/v3/conversations/${conversationId}/messages`);
      if (!r.ok) throw new Error(`v3 listMessages ${r.status}`);
      return items(unwrap(r.json)) as Array<{
        id: string; content: string | null; ai: boolean; source: string;
        channel: string | null; createdAt: string;
      }>;
    },
    async chatCompletion(a: {
      assistantId: string; conversationId: string; additionalInstructions: string;
    }) {
      const r = await call("POST", "api/v3/chat/completions", {
        assistant_id: a.assistantId,
        conversation_id: a.conversationId,
        additional_instructions: a.additionalInstructions,
      });
      return r.ok ? { ok: true as const } : { ok: false as const, error: `v3 chat ${r.status}` };
    },
    async listAssistants() {
      const r = await call("GET", "api/v3/assistants?limit=100");
      if (!r.ok) throw new Error(`v3 listAssistants ${r.status}`);
      return items(unwrap(r.json)) as Array<{ id: string; name: string }>;
    },
    async createTool(input: { name: string; description: string; url: string; httpMethod: "POST" }) {
      const r = await call("POST", "api/v3/tools", input);
      if (!r.ok) throw new Error(`v3 createTool ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
      const d = unwrap(r.json) as { id?: string } | null;
      return { id: d?.id ?? null, raw: r.json };
    },
    async validateKey(): Promise<boolean> {
      try {
        const r = await call("GET", "api/v3/conversations?sort=newest&limit=1");
        return r.ok;
      } catch { return false; }
    },
  };
}
export type V3Client = ReturnType<typeof createV3Client>;
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: v3 api client with defensive envelope unwrapping"`

---

### Task 4: GHL client (PIT — fresh attachment URLs)

**Files:**
- Create: `src/clients/ghl.ts`
- Test: `test/ghl.test.ts`

**Interfaces:**
- Produces: `createGhlClient({ baseUrl, pit, fetchImpl? })` with:
  - `latestMediaMessages({ locationId, contactId, limit? }): Promise<Array<{ id: string; attachments: string[]; direction: string; dateAdded: string }>>` — GET `/conversations/search?locationId=&contactId=` → take newest conversation id → GET `/conversations/:id/messages`, filter `direction === "inbound"` AND `attachments.length > 0`, newest first.
  - `validatePit(locationId): Promise<boolean>` — the search call succeeds.
- Headers on every call: `Authorization: Bearer <pit>`, `Version: 2021-04-15`, `Accept: application/json`.

- [ ] **Step 1: Write failing tests**

`test/ghl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGhlClient } from "../src/clients/ghl";

function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("ghl client", () => {
  it("finds newest inbound media messages for a contact", async () => {
    const { impl, calls } = fakeFetch({
      "/conversations/search": { conversations: [{ id: "conv9" }] },
      "/conversations/conv9/messages": { messages: { messages: [
        { id: "g1", direction: "inbound", attachments: [], dateAdded: "2026-07-23T01:00:00Z" },
        { id: "g2", direction: "inbound", attachments: ["https://cdn/x.ogg"], dateAdded: "2026-07-23T02:00:00Z" },
        { id: "g3", direction: "outbound", attachments: ["https://cdn/y.png"], dateAdded: "2026-07-23T03:00:00Z" },
      ] } },
    });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    const rows = await ghl.latestMediaMessages({ locationId: "L", contactId: "C" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("g2");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer P");
    expect(h.Version).toBe("2021-04-15");
  });
  it("returns [] when contact has no conversations", async () => {
    const { impl } = fakeFetch({ "/conversations/search": { conversations: [] } });
    const ghl = createGhlClient({ baseUrl: "https://g", pit: "P", fetchImpl: impl });
    expect(await ghl.latestMediaMessages({ locationId: "L", contactId: "C" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/clients/ghl.ts`:

```ts
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
        `/conversations/search?locationId=${encodeURIComponent(q.locationId)}&contactId=${encodeURIComponent(q.contactId)}`
      );
      if (!search.ok) throw new Error(`ghl conversations/search ${search.status}`);
      const convs = (search.json?.conversations ?? []) as Array<{ id: string }>;
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
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: ghl pit client — fresh inbound media lookup"`

---

### Task 5: Media sniffing + guarded download

**Files:**
- Create: `src/media/sniff.ts`, `src/media/download.ts`
- Test: `test/media.test.ts`

**Interfaces:**
- Produces: `sniff(bytes: Uint8Array): { kind: "audio" | "image" | "pdf" | "unknown"; mime: string }` — magic bytes only, never extensions. Recognized: jpg, png, gif, webp (image); ogg/opus, mp3, m4a/mp4, wav, amr (audio); pdf.
- Produces: `downloadMedia(url: string, { fetchImpl?, maxBytes? }): Promise<{ bytes: Uint8Array } | { error: "disallowed_host" | "too_large" | "fetch_failed" }>` — host allowlist: hostname ends with `leadconnectorhq.com`, `msgsndr.com`, or `assistable.ai`; default cap 25 MB.

- [ ] **Step 1: Write failing tests**

`test/media.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sniff } from "../src/media/sniff";
import { downloadMedia } from "../src/media/download";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("sniff", () => {
  it("detects common types by magic bytes", () => {
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0)).mime).toBe("image/jpeg");
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47)).mime).toBe("image/png");
    expect(sniff(new TextEncoder().encode("OggS....")).mime).toBe("audio/ogg");
    expect(sniff(new TextEncoder().encode("%PDF-1.7")).kind).toBe("pdf");
    expect(sniff(new TextEncoder().encode("ID3\x03tag")).mime).toBe("audio/mpeg");
    const m4a = new Uint8Array(12); m4a.set(new TextEncoder().encode("ftyp"), 4);
    expect(sniff(m4a).mime).toBe("audio/mp4");
    expect(sniff(bytes(1, 2, 3)).kind).toBe("unknown");
  });
  it("detects webp vs wav (RIFF disambiguation)", () => {
    const webp = new Uint8Array(12);
    webp.set(new TextEncoder().encode("RIFF"), 0); webp.set(new TextEncoder().encode("WEBP"), 8);
    const wav = new Uint8Array(12);
    wav.set(new TextEncoder().encode("RIFF"), 0); wav.set(new TextEncoder().encode("WAVE"), 8);
    expect(sniff(webp).mime).toBe("image/webp");
    expect(sniff(wav).mime).toBe("audio/wav");
  });
});

describe("downloadMedia", () => {
  const ok = (body: Uint8Array) => (async () => new Response(body)) as unknown as typeof fetch;
  it("rejects non-allowlisted hosts without fetching", async () => {
    let fetched = false;
    const spy = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const r = await downloadMedia("https://evil.example.com/a.ogg", { fetchImpl: spy });
    expect(r).toEqual({ error: "disallowed_host" });
    expect(fetched).toBe(false);
  });
  it("downloads from GHL CDN and enforces cap", async () => {
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: ok(new Uint8Array(10)) });
    expect("bytes" in r && r.bytes.length).toBe(10);
    const big = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
      fetchImpl: ok(new Uint8Array(50)), maxBytes: 40,
    });
    expect(big).toEqual({ error: "too_large" });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/media/sniff.ts`:

```ts
export interface SniffResult { kind: "audio" | "image" | "pdf" | "unknown"; mime: string }

const ascii = (b: Uint8Array, start: number, len: number) =>
  new TextDecoder("ascii").decode(b.slice(start, start + len));

export function sniff(b: Uint8Array): SniffResult {
  if (b.length >= 4) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { kind: "image", mime: "image/png" };
    if (ascii(b, 0, 3) === "GIF") return { kind: "image", mime: "image/gif" };
    if (ascii(b, 0, 4) === "RIFF" && b.length >= 12) {
      const fmt = ascii(b, 8, 4);
      if (fmt === "WEBP") return { kind: "image", mime: "image/webp" };
      if (fmt === "WAVE") return { kind: "audio", mime: "audio/wav" };
    }
    if (ascii(b, 0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg" };
    if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
      return { kind: "audio", mime: "audio/mpeg" };
    if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") return { kind: "audio", mime: "audio/mp4" };
    if (ascii(b, 0, 5) === "#!AMR") return { kind: "audio", mime: "audio/amr" };
    if (ascii(b, 0, 4) === "%PDF") return { kind: "pdf", mime: "application/pdf" };
  }
  return { kind: "unknown", mime: "application/octet-stream" };
}
```

`src/media/download.ts`:

```ts
const ALLOWED_SUFFIXES = ["leadconnectorhq.com", "msgsndr.com", "assistable.ai"];
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export type DownloadResult =
  | { bytes: Uint8Array }
  | { error: "disallowed_host" | "too_large" | "fetch_failed" };

export async function downloadMedia(
  url: string,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number } = {}
): Promise<DownloadResult> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let host: string;
  try { host = new URL(url).hostname; } catch { return { error: "fetch_failed" }; }
  if (!ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return { error: "disallowed_host" };
  }
  try {
    const res = await f(url);
    if (!res.ok) return { error: "fetch_failed" };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) return { error: "too_large" };
    return { bytes: buf };
  } catch { return { error: "fetch_failed" }; }
}
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: magic-byte sniffing + allowlisted guarded download"`

---

### Task 6: Provider adapters (Gemini, OpenAI)

**Files:**
- Create: `src/providers/types.ts`, `src/providers/gemini.ts`, `src/providers/openai.ts`, `src/providers/index.ts`
- Test: `test/providers.test.ts`

**Interfaces:**
- Produces: `interface MediaProvider { describe(input: { kind: "audio" | "image" | "pdf"; mime: string; bytes: Uint8Array }): Promise<string>; validateKey(): Promise<boolean> }`
- Produces: `getProvider(name: "gemini" | "openai", apiKey: string, fetchImpl?): MediaProvider`
- Gemini: `POST {base}/v1beta/models/{model}:generateContent?key={apiKey}` with `contents: [{ parts: [{ inline_data: { mime_type, data: base64 } }, { text: prompt }] }]`; model env `GEMINI_MODEL` default `gemini-2.5-flash`; handles audio, image, and pdf natively. Response text = join of `candidates[0].content.parts[].text`.
- OpenAI: audio → `POST /v1/audio/transcriptions` (multipart FormData: `model=whisper-1`, `file`); image → `POST /v1/chat/completions` (`gpt-4o-mini`, `image_url` data URL). `pdf` → returns the fixed string `"[PDF reading is not yet supported on the OpenAI provider]"` (fast-follow).
- Prompts: audio → `"Transcribe this voice message verbatim. Reply with ONLY the transcript text."`; image → `"Describe this image for a customer-support agent. Extract ALL visible text verbatim (OCR), then add a one-sentence description of what the image shows."`; pdf → `"Extract the full text of this document, then summarize it in 2 sentences."`

- [ ] **Step 1: Write failing tests**

`test/providers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getProvider } from "../src/providers";

const capture = (body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
};

describe("gemini adapter", () => {
  it("sends inline_data and joins candidate text", async () => {
    const { impl, calls } = capture({
      candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }],
    });
    const p = getProvider("gemini", "GK", impl);
    const out = await p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1, 2]) });
    expect(out).toBe("hello world");
    expect(calls[0].url).toContain(":generateContent?key=GK");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("audio/ogg");
  });
});

describe("openai adapter", () => {
  it("routes audio to whisper transcriptions", async () => {
    const { impl, calls } = capture({ text: "the transcript" });
    const p = getProvider("openai", "OK", impl);
    const out = await p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) });
    expect(out).toBe("the transcript");
    expect(calls[0].url).toContain("/v1/audio/transcriptions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer OK");
  });
  it("routes image to chat completions with a data URL", async () => {
    const { impl, calls } = capture({ choices: [{ message: { content: "a receipt" } }] });
    const p = getProvider("openai", "OK", impl);
    const out = await p.describe({ kind: "image", mime: "image/png", bytes: new Uint8Array([9]) });
    expect(out).toBe("a receipt");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
  it("pdf returns the unsupported notice", async () => {
    const p = getProvider("openai", "OK", capture({}).impl);
    const out = await p.describe({ kind: "pdf", mime: "application/pdf", bytes: new Uint8Array([1]) });
    expect(out).toContain("not yet supported");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/providers/types.ts`:

```ts
export interface MediaInput { kind: "audio" | "image" | "pdf"; mime: string; bytes: Uint8Array }
export interface MediaProvider {
  describe(input: MediaInput): Promise<string>;
  validateKey(): Promise<boolean>;
}
export const PROMPTS = {
  audio: "Transcribe this voice message verbatim. Reply with ONLY the transcript text.",
  image: "Describe this image for a customer-support agent. Extract ALL visible text verbatim (OCR), then add a one-sentence description of what the image shows.",
  pdf: "Extract the full text of this document, then summarize it in 2 sentences.",
} as const;
export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
```

`src/providers/gemini.ts`:

```ts
import { type MediaInput, type MediaProvider, PROMPTS, toBase64 } from "./types";

const BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export function geminiProvider(apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  const f = fetchImpl ?? fetch;
  const generate = async (parts: unknown[]) => {
    const res = await f(`${BASE}/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "").join("");
    if (!text.trim()) throw new Error("gemini returned no text");
    return text;
  };
  return {
    describe: (input: MediaInput) =>
      generate([
        { inline_data: { mime_type: input.mime, data: toBase64(input.bytes) } },
        { text: PROMPTS[input.kind] },
      ]),
    async validateKey() {
      try { await generate([{ text: "Reply with the single word: ok" }]); return true; }
      catch { return false; }
    },
  };
}
```

`src/providers/openai.ts`:

```ts
import { type MediaInput, type MediaProvider, PROMPTS, toBase64 } from "./types";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";

export function openaiProvider(apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  const f = fetchImpl ?? fetch;
  return {
    async describe(input: MediaInput) {
      if (input.kind === "pdf") return "[PDF reading is not yet supported on the OpenAI provider]";
      if (input.kind === "audio") {
        const form = new FormData();
        form.set("model", "whisper-1");
        form.set("file", new Blob([Buffer.from(input.bytes)], { type: input.mime }), "audio.ogg");
        const res = await f(`${BASE}/v1/audio/transcriptions`, {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
        });
        if (!res.ok) throw new Error(`openai whisper ${res.status}`);
        const json = (await res.json()) as { text?: string };
        if (!json.text) throw new Error("openai whisper returned no text");
        return json.text;
      }
      const res = await f(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${input.mime};base64,${toBase64(input.bytes)}` } },
            { type: "text", text: PROMPTS.image },
          ] }],
        }),
      });
      if (!res.ok) throw new Error(`openai vision ${res.status}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("openai vision returned no text");
      return text;
    },
    async validateKey() {
      try {
        const res = await f(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
        return res.ok;
      } catch { return false; }
    },
  };
}
```

`src/providers/index.ts`:

```ts
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import type { MediaProvider } from "./types";

export type ProviderName = "gemini" | "openai";
export function getProvider(name: ProviderName, apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  return name === "gemini" ? geminiProvider(apiKey, fetchImpl) : openaiProvider(apiKey, fetchImpl);
}
export type { MediaProvider } from "./types";
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: gemini + openai media provider adapters"`

---

### Task 7: Processing core (`analyzeForContact`)

**Files:**
- Create: `src/core/analyze.ts`
- Test: `test/analyze.test.ts`

**Interfaces:**
- Consumes: `GhlClient.latestMediaMessages`, `downloadMedia`, `sniff`, `getProvider`, `ProcessedStore`, `EventStore`, `Tenant`.
- Produces: `analyzeForContact(deps, tenant, contactId): Promise<{ text: string; processedIds: string[] }>` where `deps = { ghl: GhlClient; processed: ProcessedStore; events: EventStore; provider: MediaProvider; fetchImpl?: typeof fetch }`.
- Behavior: fetch latest inbound media messages → skip already-processed ids → for each attachment (max 3 attempted per call): download → sniff → skip modality if tenant toggle off (note in output) → provider.describe → assemble labeled sections (`🎤 Voice note transcript: …` / `📷 Image: …` / `📄 Document: …`). Attachments beyond the cap are **deliberately dropped** with a single honest note `[N additional attachment(s) were not processed]` — never deferred (their message ids ARE marked processed; retrying stale media in a later run would confuse the conversation). Failed/disabled attempts still consume cap slots (the cap bounds attempted work/cost). The whole per-attachment body is try/caught — the function NEVER throws for per-attachment errors. If zero sections were produced → text `"[no new attachments found]"` with nothing marked processed. Marks message ids processed ONLY after assembly. Records `tool_call` event with counts (no content).

- [ ] **Step 1: Write failing tests**

`test/analyze.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createProcessedStore } from "../src/store/processed";
import { createEventStore } from "../src/store/events";
import { analyzeForContact } from "../src/core/analyze";
import type { Tenant } from "../src/store/tenants";

const tenant = {
  id: "t1", token: "tok", label: "T", locationId: "L", assistantId: "A",
  provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
  wakerEnabled: true, toolId: null, enabled: true,
  modalities: { audio: true, image: true },
} as Tenant;

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  const db = openDb(":memory:");
  return {
    ghl: {
      latestMediaMessages: async () => [
        { id: "g2", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t2" },
      ],
      validatePit: async () => true,
    },
    processed: createProcessedStore(db),
    events: createEventStore(db),
    provider: {
      describe: async () => "hello from the voice note",
      validateKey: async () => true,
    },
    fetchImpl: (async () => new Response(oggBytes)) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("analyzeForContact", () => {
  it("downloads, sniffs, describes, labels, and marks processed", async () => {
    const d = deps();
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("Voice note transcript");
    expect(r.text).toContain("hello from the voice note");
    expect(r.processedIds).toEqual(["g2"]);
    expect(d.processed.has("t1", "g2")).toBe(true);
  });
  it("skips already-processed messages", async () => {
    const d = deps();
    d.processed.add("t1", "g2");
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("no new attachments");
  });
  it("degrades per-attachment on provider failure without throwing", async () => {
    const d = deps({ provider: {
      describe: async () => { throw new Error("rate limited"); },
      validateKey: async () => true,
    } });
    const r = await analyzeForContact(d as never, tenant, "C1");
    expect(r.text).toContain("could not be read");
  });
  it("respects modality toggles", async () => {
    const t2 = { ...tenant, modalities: { audio: false, image: true } };
    const r = await analyzeForContact(deps() as never, t2 as Tenant, "C1");
    expect(r.text).toContain("audio processing is disabled");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/core/analyze.ts`:

```ts
import type { GhlClient } from "../clients/ghl";
import { downloadMedia } from "../media/download";
import { sniff } from "../media/sniff";
import type { MediaProvider } from "../providers";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";

export interface AnalyzeDeps {
  ghl: Pick<GhlClient, "latestMediaMessages">;
  processed: ProcessedStore;
  events: EventStore;
  provider: MediaProvider;
  fetchImpl?: typeof fetch;
}

const LABELS = { audio: "🎤 Voice note transcript", image: "📷 Image", pdf: "📄 Document" } as const;
const MAX_ATTACHMENTS = 3;

export async function analyzeForContact(
  deps: AnalyzeDeps, tenant: Tenant, contactId: string
): Promise<{ text: string; processedIds: string[] }> {
  const messages = await deps.ghl.latestMediaMessages({
    locationId: tenant.locationId, contactId,
  });
  const fresh = messages.filter((m) => !deps.processed.has(tenant.id, m.id));
  if (fresh.length === 0) {
    return { text: "[no new attachments found]", processedIds: [] };
  }

  const sections: string[] = [];
  let count = 0;
  for (const msg of fresh) {
    for (const url of msg.attachments) {
      if (count >= MAX_ATTACHMENTS) { sections.push("[additional attachments were skipped]"); break; }
      count += 1;
      const dl = await downloadMedia(url, { fetchImpl: deps.fetchImpl });
      if ("error" in dl) { sections.push(`[attachment could not be read: ${dl.error}]`); continue; }
      const s = sniff(dl.bytes);
      if (s.kind === "unknown") { sections.push("[attachment could not be read: unsupported_type]"); continue; }
      if (s.kind === "audio" && !tenant.modalities.audio) { sections.push("[audio processing is disabled for this account]"); continue; }
      if (s.kind === "image" && !tenant.modalities.image) { sections.push("[image processing is disabled for this account]"); continue; }
      try {
        const text = await deps.provider.describe({ kind: s.kind, mime: s.mime, bytes: dl.bytes });
        sections.push(`${LABELS[s.kind]}: ${text}`);
      } catch (err) {
        sections.push(`[attachment could not be read: ${err instanceof Error ? err.message : "provider_error"}]`);
      }
    }
  }
  const processedIds = fresh.map((m) => m.id);
  for (const id of processedIds) deps.processed.add(tenant.id, id);
  deps.events.record(tenant.id, "tool_call", `attachments=${count} messages=${processedIds.length}`);
  return { text: sections.join("\n\n"), processedIds };
}
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: processing core — locate, download, sniff, describe, dedupe"`

---

### Task 8: Tool endpoint (Door 1 — Assistable envelope)

**Files:**
- Create: `src/http/tool.ts`
- Test: `test/tool-endpoint.test.ts`

**Interfaces:**
- Consumes: `TenantStore.getByToken`, `analyzeForContact`, `getProvider`, `createGhlClient`.
- Produces: Express router factory `createToolRouter(ctx)` where `ctx = { tenants: TenantStore; processed: ProcessedStore; events: EventStore; ghlFactory(tenant): GhlClient; providerFactory(tenant): MediaProvider; mediaFetch?: typeof fetch }`. Route: `POST /tool/:token`. (`config` was dropped from the ctx 2026-07-23 — dead field.)
- Envelope handling (source-verified): body is `{ args, meta_data, metadata, call }`; contact/location read from `meta_data ?? metadata` keys `contact_id`/`contactId` + `location_id`/`locationId` (both casings tolerated — spike confirms the real one). Response is the raw JSON the LLM sees: `{ result: string }`. Errors NEVER 500 to the assistant: unknown token → 404 `{ result: "[media reader is not configured for this account]" }`; disabled tenant → 200 with `{ result: "[media reader is disabled]" }`; missing contact → 200 `{ result: "[no contact context supplied]" }`.

- [ ] **Step 1: Write failing tests**

`test/tool-endpoint.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import { createTenantStore } from "../src/store/tenants";
import { createToolRouter } from "../src/http/tool";

process.env.MOCK_MODE = "1";

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function makeApp() {
  const db = openDb(":memory:");
  const key = Buffer.alloc(32, 1);
  const tenants = createTenantStore(db, key);
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const app = express();
  app.use(express.json());
  app.use(createToolRouter({
    tenants,
    processed: createProcessedStore(db),
    events: createEventStore(db),
    config: loadConfig(),
    ghlFactory: () => ({
      latestMediaMessages: async () => [
        { id: "g1", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t" },
      ],
      validatePit: async () => true,
    }) as never,
    providerFactory: () => ({
      describe: async () => "voice says hi",
      validateKey: async () => true,
    }),
    mediaFetch: (async () => new Response(oggBytes)) as unknown as typeof fetch,
  }));
  return { app, token: t.token };
}

describe("POST /tool/:token", () => {
  it("processes the envelope and returns a result string", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({
      args: {}, meta_data: { contact_id: "C1", location_id: "L1" }, metadata: {}, call: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("voice says hi");
  });
  it("tolerates camelCase metadata keys", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({
      args: {}, metadata: { contactId: "C1", locationId: "L1" },
    });
    expect(res.body.result).toContain("voice says hi");
  });
  it("unknown token → 404 with an LLM-safe result", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/tool/nope").send({ args: {} });
    expect(res.status).toBe(404);
    expect(res.body.result).toContain("not configured");
  });
  it("missing contact context → LLM-safe result, no crash", async () => {
    const { app, token } = makeApp();
    const res = await request(app).post(`/tool/${token}`).send({ args: {} });
    expect(res.status).toBe(200);
    expect(res.body.result).toContain("no contact context");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/http/tool.ts`:

```ts
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
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: tool endpoint — assistable envelope in, LLM-safe result out"`

---

### Task 9: Waker (Door 2 — detect media-only, wake the assistant)

**Files:**
- Create: `src/core/waker.ts`
- Test: `test/waker.test.ts`

**Interfaces:**
- Consumes: `V3Client.listConversations/listMessages/chatCompletion`, `ProcessedStore`, `EventStore`, `Tenant`.
- Produces: `runWakerCycle(deps, tenant): Promise<{ woken: number }>` with `deps = { v3: Pick<V3Client, "listConversations" | "listMessages" | "chatCompletion">; processed: ProcessedStore; events: EventStore; state: WakerState }`; `WakerState = Map<string, string>` (tenantId → last-seen `updatedAt` cursor).
- Media signature: `m.source === "USER" && m.ai === false && (!m.content || m.content.trim() === "")`.
- Cycle (RELIABILITY-HARDENED 2026-07-23 — supersedes the mark-before-wake ordering): list newest N conversations (`WAKER_CONV_LIMIT`, default 50) → prime-only on first run (cursor undefined → set to batch-newest, wake nothing) → process the `updatedAt > cursor` set **in ascending `updatedAt` order**, advancing the cursor **only past conversations actually finished**. Per conversation, in a try/catch: list messages → media-only signature not already `waker:`-processed → ONE `chatCompletion` per conversation (not per message), `assistant_id` = conversation's assistant if present else tenant default → **on `ok`: mark those message ids `waker:<msgId>` processed + record `wake`; on `ok:false`: mark processed (attempted, no retry-storm) + record `error`** → advance cursor to this conversation's `updatedAt`. A **hard throw** (listMessages/chatCompletion rejects) records an `error` event and **breaks without advancing the cursor and without marking** — so that conversation and everything after it retry next cycle instead of being silently skipped. (Mark-after-wake replaces the brief's original mark-before-wake: mark-before permanently loses the wake on a transient failure; the narrow crash-after-wake-before-mark window risks at most one duplicate wake, the safer trade.) Instruction text exactly:
  `[media-mcp] The contact just sent one or more attachments (an image, document, or voice note) that you cannot see directly. Call the analyze_attachment tool now to read them, then respond helpfully to the contact based on what the tool returns. Do not mention any technical process or tools to the contact.`
- Produces: `startWaker(depsFactory, tenants, intervalMs): { stop(): void }` — setInterval loop over enabled tenants with `wakerEnabled`, each cycle isolated in try/catch, `error` event on failure.

- [ ] **Step 1: Write failing tests**

`test/waker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import { runWakerCycle } from "../src/core/waker";
import type { Tenant } from "../src/store/tenants";

const tenant = {
  id: "t1", token: "tok", label: "T", locationId: "L", assistantId: "A_default",
  provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
  wakerEnabled: true, toolId: null, enabled: true,
  modalities: { audio: true, image: true },
} as Tenant;

const msg = (id: string, over: Partial<{ content: string | null; ai: boolean; source: string }> = {}) => ({
  id, content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t", ...over,
});

function make(convUpdatedAt: string, messages: ReturnType<typeof msg>[]) {
  const db = openDb(":memory:");
  const wakes: Array<{ assistantId: string; conversationId: string; additionalInstructions: string }> = [];
  const deps = {
    v3: {
      listConversations: async () => [
        { id: "c1", contactId: "ct1", updatedAt: convUpdatedAt, assistant: { id: "A_conv" } },
      ],
      listMessages: async () => messages,
      chatCompletion: async (a: typeof wakes[number]) => { wakes.push(a); return { ok: true as const }; },
    },
    processed: createProcessedStore(db),
    events: createEventStore(db),
    state: new Map<string, string>(),
  };
  return { deps, wakes };
}

describe("runWakerCycle", () => {
  it("first run primes the cursor and wakes nothing", async () => {
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [msg("m1")]);
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(deps.state.get("t1")).toBe("2026-07-23T10:00:00Z");
  });
  it("wakes once per conversation with new media-only messages", async () => {
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [msg("m1"), msg("m2")]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(1);
    expect(wakes[0].assistantId).toBe("A_conv"); // conversation assistant wins
    expect(wakes[0].additionalInstructions).toMatch(/^\[media-mcp\]/);
    expect(wakes[0].additionalInstructions).toContain("analyze_attachment");
  });
  it("ignores non-matching messages and already-woken ids", async () => {
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [
      msg("m1", { content: "hello" }),          // has text
      msg("m2", { source: "ASSISTANT" }),        // outbound
      msg("m3", { ai: true }),                   // AI message
      msg("m4"),                                  // media-only — but seen below
    ]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    deps.processed.add("t1", "waker:m4");
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(0);
    expect(wakes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/core/waker.ts`:

```ts
import type { V3Client } from "../clients/v3";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";

export type WakerState = Map<string, string>;

export interface WakerDeps {
  v3: Pick<V3Client, "listConversations" | "listMessages" | "chatCompletion">;
  processed: ProcessedStore;
  events: EventStore;
  state: WakerState;
}

export const WAKE_INSTRUCTION =
  "[media-mcp] The contact just sent one or more attachments (an image, document, " +
  "or voice note) that you cannot see directly. Call the analyze_attachment tool " +
  "now to read them, then respond helpfully to the contact based on what the tool " +
  "returns. Do not mention any technical process or tools to the contact.";

const isMediaOnly = (m: { content: string | null; ai: boolean; source: string }) =>
  m.source === "USER" && m.ai === false && (!m.content || m.content.trim() === "");

export async function runWakerCycle(deps: WakerDeps, tenant: Tenant): Promise<{ woken: number }> {
  const conversations = await deps.v3.listConversations(25);
  deps.events.record(tenant.id, "poll", `conversations=${conversations.length}`);
  if (conversations.length === 0) return { woken: 0 };

  const newest = conversations
    .map((c) => c.updatedAt).sort().at(-1) ?? "";
  const cursor = deps.state.get(tenant.id);
  deps.state.set(tenant.id, newest > (cursor ?? "") ? newest : (cursor ?? newest));
  if (cursor === undefined) return { woken: 0 }; // prime only — never storm history

  let woken = 0;
  for (const conv of conversations) {
    if (conv.updatedAt <= cursor) continue;
    const messages = await deps.v3.listMessages(conv.id);
    const fresh = messages.filter(
      (m) => isMediaOnly(m) && !deps.processed.has(tenant.id, `waker:${m.id}`)
    );
    if (fresh.length === 0) continue;
    for (const m of fresh) deps.processed.add(tenant.id, `waker:${m.id}`);
    deps.events.record(tenant.id, "detect", `conv=${conv.id} mediaOnly=${fresh.length}`);
    const assistantId = conv.assistant?.id ?? tenant.assistantId;
    const r = await deps.v3.chatCompletion({
      assistantId, conversationId: conv.id, additionalInstructions: WAKE_INSTRUCTION,
    });
    if (r.ok) { woken += 1; deps.events.record(tenant.id, "wake", `conv=${conv.id}`); }
    else deps.events.record(tenant.id, "error", `wake failed conv=${conv.id}: ${r.error}`);
  }
  return { woken };
}

export function startWaker(
  cycleFor: (tenant: Tenant) => Promise<{ woken: number }>,
  listTenants: () => Tenant[],
  intervalMs: number
): { stop(): void } {
  const timer = setInterval(async () => {
    for (const t of listTenants()) {
      if (!t.enabled || !t.wakerEnabled) continue;
      try { await cycleFor(t); } catch { /* cycle errors recorded downstream */ }
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: waker — media-only detection + assistant wake via chat completions"`

---

### Task 10: MCP server surface (Door 3)

**Files:**
- Create: `src/http/mcp.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `downloadMedia`, `sniff`, `getProvider`, `TenantStore`.
- Produces: `createMcpRouter(ctx)` mounting `POST /mcp/:token` (Streamable HTTP, stateless per-request pattern from `@modelcontextprotocol/sdk`). Tools registered per request against the token's tenant:
  - `analyze_attachment { url: string }` → download → sniff → provider.describe → text
  - `transcribe_audio { url: string }` → same but errors if sniffed kind ≠ audio
  - `analyze_image { url: string }` → same but errors if kind ≠ image
  - `read_document { url: string }` → kind must be pdf; gemini only (openai returns unsupported notice)
  - `status {}` → `{ label, provider, modalities, wakerEnabled }` JSON text
- Uses `McpServer` + `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` (stateless), `enableJsonResponse: true`. Unknown token → HTTP 401.

- [ ] **Step 1: Write failing test**

`test/mcp.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { createMcpRouter } from "../src/http/mcp";

const oggBytes = new TextEncoder().encode("OggS....voicedata");

function makeApp() {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 1));
  const t = tenants.create({
    label: "T", locationId: "L1", assistantId: "A1", provider: "gemini",
    v3Key: "v", ghlPit: "p", aiKey: "k",
  });
  const app = express();
  app.use(express.json());
  app.use(createMcpRouter({
    tenants,
    providerFactory: () => ({ describe: async () => "transcript!", validateKey: async () => true }),
    mediaFetch: (async () => new Response(oggBytes)) as unknown as typeof fetch,
  }));
  return { app, token: t.token };
}

const rpc = (method: string, params: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("mcp endpoint", () => {
  it("lists tools", async () => {
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/list", {}));
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("analyze_attachment");
    expect(names).toContain("transcribe_audio");
    expect(names).toContain("status");
  });
  it("calls analyze_attachment end to end", async () => {
    const { app, token } = makeApp();
    const res = await request(app)
      .post(`/mcp/${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/call", {
        name: "analyze_attachment",
        arguments: { url: "https://storage.msgsndr.com/a.ogg" },
      }));
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toContain("transcript!");
  });
  it("rejects unknown token", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/mcp/badtoken")
      .set("Accept", "application/json, text/event-stream")
      .send(rpc("tools/list", {}));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/http/mcp.ts`:

```ts
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

  const fetchAndSniff = async (url: string) => {
    const dl = await downloadMedia(url, { fetchImpl: ctx.mediaFetch });
    if ("error" in dl) return { error: `download failed: ${dl.error}` } as const;
    return { bytes: dl.bytes, sniffed: sniff(dl.bytes) } as const;
  };
  const analyze = async (url: string, expect?: "audio" | "image" | "pdf") => {
    const r = await fetchAndSniff(url);
    if ("error" in r) return errText(r.error);
    if (r.sniffed.kind === "unknown") return errText("unsupported media type");
    if (expect && r.sniffed.kind !== expect) return errText(`expected ${expect}, got ${r.sniffed.kind}`);
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
    const tenant = ctx.tenants.getByToken(req.params.token);
    if (!tenant || !tenant.enabled) { res.status(401).json({ error: "unknown or disabled token" }); return; }
    // Stateless: fresh server + transport per request (SDK-documented pattern).
    const server = buildServer(ctx, tenant);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
    });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return router;
}
```

- [ ] **Step 4: Run tests green** (if the SDK rejects `tools/list` without an `initialize` handshake in stateless mode, prepend an `initialize` request in each test using the same pattern and assert on the second response — keep assertions identical).
- [ ] **Step 5: Commit** — `git commit -am "feat: streamable-http mcp server surface (door 3)"`

---

### Task 11: Portal (onboarding + auto-provision + health)

**Files:**
- Create: `src/http/portal.ts`, `src/core/provision.ts`
- Test: `test/portal.test.ts`, `test/provision.test.ts`

**Interfaces:**
- Consumes: `V3Client` (validateKey, listAssistants, createTool), `GhlClient.validatePit`, `getProvider(...).validateKey`, `TenantStore`, `EventStore`.
- Produces: `provisionTenant(deps, input): Promise<{ tenant: Tenant; toolId: string | null; warnings: string[] }>` — validates all three credentials live (fail → throw with a which-credential message), creates tenant row, then creates the CUSTOM tool via v3 `createTool` with `{ name: "analyze_attachment", description: TOOL_DESCRIPTION, url: "<publicBaseUrl>/tool/<token>", httpMethod: "POST" }`; tool-create failure is a WARNING (portal shows manual-create instructions), not a rollback.
- `TOOL_DESCRIPTION` exactly: `"Read the contact's most recent attachment (voice note, image, or document) and return its content as text. Call this whenever the contact sends or mentions an attachment, photo, voice note, or document."`
- Produces: portal routes — `GET /` (form), `POST /setup` (runs provisionTenant; renders success page with tool status, MCP URL `/mcp/<token>`, prompt snippet to copy), `GET /dashboard/:token` (tenant health: latest 20 events, toggles), `POST /dashboard/:token/toggle` (enabled/waker/modalities). Server-rendered template strings; no client framework. NOTE for executor: portal UI work must invoke the frontend-design + ui-ux-pro-max skills per Hari's standing rule before styling.

- [ ] **Step 1: Write failing tests**

`test/provision.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";
import { provisionTenant } from "../src/core/provision";

const input = {
  label: "Vol 1", locationId: "L1", assistantId: "A1",
  provider: "gemini" as const, v3Key: "v3", ghlPit: "pit", aiKey: "gk",
};

function deps(over: Partial<Record<string, unknown>> = {}) {
  const db = openDb(":memory:");
  return {
    tenants: createTenantStore(db, Buffer.alloc(32, 2)),
    publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => true,
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => ({ id: "tool_9", raw: {} }),
    }),
    ghlFactory: () => ({ validatePit: async () => true }),
    providerFactory: () => ({ validateKey: async () => true, describe: async () => "" }),
    ...over,
  };
}

describe("provisionTenant", () => {
  it("validates all creds, creates tenant + tool", async () => {
    const d = deps();
    const r = await provisionTenant(d as never, input);
    expect(r.tenant.token).toBeTruthy();
    expect(r.toolId).toBe("tool_9");
    expect(r.warnings).toEqual([]);
    expect(d.tenants.getByToken(r.tenant.token)?.toolId).toBe("tool_9");
  });
  it("throws naming the failing credential", async () => {
    const d = deps({ ghlFactory: () => ({ validatePit: async () => false }) });
    await expect(provisionTenant(d as never, input)).rejects.toThrow(/GHL/i);
  });
  it("tool-create failure is a warning, not a rollback", async () => {
    const d = deps({ v3Factory: () => ({
      validateKey: async () => true,
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => { throw new Error("tools scope missing"); },
    }) });
    const r = await provisionTenant(d as never, input);
    expect(r.toolId).toBeNull();
    expect(r.warnings[0]).toContain("tool");
    expect(d.tenants.getByToken(r.tenant.token)).toBeTruthy();
  });
});
```

`test/portal.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createTenantStore } from "../src/store/tenants";
import { createPortalRouter } from "../src/http/portal";

function makeApp() {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 3));
  const events = createEventStore(db);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(createPortalRouter({
    tenants, events, publicBaseUrl: "https://media.example.com",
    v3Factory: () => ({
      validateKey: async () => true,
      listAssistants: async () => [{ id: "A1", name: "Bot" }],
      createTool: async () => ({ id: "tool_1", raw: {} }),
    }) as never,
    ghlFactory: () => ({ validatePit: async () => true }) as never,
    providerFactory: () => ({ validateKey: async () => true, describe: async () => "" }),
  }));
  return { app, tenants, events };
}

describe("portal", () => {
  it("GET / renders the setup form", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Assistable v3 API key");
  });
  it("POST /setup provisions and shows the MCP URL + prompt snippet", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/setup").type("form").send({
      label: "Vol", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("/mcp/");
    expect(res.text).toContain("analyze_attachment");
  });
  it("dashboard shows health events", async () => {
    const { app, tenants, events } = makeApp();
    const t = tenants.create({
      label: "V", locationId: "L1", assistantId: "A1",
      provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
    });
    events.record(t.id, "wake", "conv=c1");
    const res = await request(app).get(`/dashboard/${t.token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("wake");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/core/provision.ts`:

```ts
import type { GhlClient } from "../clients/ghl";
import type { V3Client } from "../clients/v3";
import type { MediaProvider } from "../providers";
import type { Tenant, TenantInput, TenantStore } from "../store/tenants";

export const TOOL_DESCRIPTION =
  "Read the contact's most recent attachment (voice note, image, or document) and " +
  "return its content as text. Call this whenever the contact sends or mentions an " +
  "attachment, photo, voice note, or document.";

export interface ProvisionDeps {
  tenants: TenantStore;
  publicBaseUrl: string;
  v3Factory: (v3Key: string) => Pick<V3Client, "validateKey" | "listAssistants" | "createTool">;
  ghlFactory: (pit: string) => Pick<GhlClient, "validatePit">;
  providerFactory: (name: TenantInput["provider"], key: string) => MediaProvider;
}

export async function provisionTenant(deps: ProvisionDeps, input: TenantInput) {
  const v3 = deps.v3Factory(input.v3Key);
  if (!(await v3.validateKey())) throw new Error("Assistable v3 API key failed validation");
  if (!(await deps.ghlFactory(input.ghlPit).validatePit(input.locationId)))
    throw new Error("GHL Private Integration Token failed validation for this location");
  if (!(await deps.providerFactory(input.provider, input.aiKey).validateKey()))
    throw new Error(`${input.provider} API key failed validation`);

  const tenant: Tenant = deps.tenants.create(input);
  const warnings: string[] = [];
  let toolId: string | null = null;
  try {
    const created = await v3.createTool({
      name: "analyze_attachment",
      description: TOOL_DESCRIPTION,
      url: `${deps.publicBaseUrl}/tool/${tenant.token}`,
      httpMethod: "POST",
    });
    toolId = created.id;
    if (toolId) deps.tenants.setToolId(tenant.id, toolId);
    else warnings.push("tool created but no id returned — verify in the dashboard");
  } catch (err) {
    warnings.push(`could not auto-create the analyze_attachment tool (${err instanceof Error ? err.message : "error"}) — create it manually in the portal UI with URL ${deps.publicBaseUrl}/tool/${tenant.token}`);
  }
  return { tenant, toolId, warnings };
}

export const PROMPT_SNIPPET =
  "If the contact sends, or refers to, a photo, image, screenshot, document, or " +
  "voice note, ALWAYS call the analyze_attachment tool first to read it, then " +
  "respond based on its content. Never say you cannot open attachments.";
```

`src/http/portal.ts` (structure — full HTML kept minimal; executor styles it under the design skills):

```ts
import { Router } from "express";
import { PROMPT_SNIPPET, type ProvisionDeps, provisionTenant } from "../core/provision";
import type { EventStore } from "../store/events";

export interface PortalCtx extends ProvisionDeps { events: EventStore }

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export function createPortalRouter(ctx: PortalCtx): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.send(page("Media MCP — Connect", `
      <h1>Media MCP — connect your subaccount</h1>
      <form method="post" action="/setup">
        <label>Label <input name="label" required></label>
        <label>GHL Location ID <input name="locationId" required></label>
        <label>Default assistant ID <input name="assistantId" required></label>
        <label>Assistable v3 API key <input name="v3Key" required></label>
        <label>GHL Private Integration Token <input name="ghlPit" required></label>
        <label>AI provider
          <select name="provider"><option value="gemini">Gemini (recommended)</option>
          <option value="openai">OpenAI</option></select></label>
        <label>AI provider key <input name="aiKey" required></label>
        <button type="submit">Validate & connect</button>
      </form>`));
  });

  router.post("/setup", async (req, res) => {
    try {
      const b = req.body as Record<string, string>;
      const r = await provisionTenant(ctx, {
        label: b.label, locationId: b.locationId, assistantId: b.assistantId,
        provider: b.provider === "openai" ? "openai" : "gemini",
        v3Key: b.v3Key, ghlPit: b.ghlPit, aiKey: b.aiKey,
      });
      res.send(page("Connected", `
        <h1>Connected ✓</h1>
        ${r.warnings.map((w) => `<p><strong>Warning:</strong> ${w}</p>`).join("")}
        <p>Tool: ${r.toolId ? `analyze_attachment created (${r.toolId})` : "manual creation needed"}</p>
        <p>MCP endpoint: <code>${ctx.publicBaseUrl}/mcp/${r.tenant.token}</code></p>
        <p>Add this to your assistant prompt:</p><pre>${PROMPT_SNIPPET}</pre>
        <p><a href="/dashboard/${r.tenant.token}">Open your dashboard</a></p>`));
    } catch (err) {
      res.status(400).send(page("Validation failed",
        `<h1>Validation failed</h1><p>${err instanceof Error ? err.message : "error"}</p><a href="/">Back</a>`));
    }
  });

  router.get("/dashboard/:token", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).send(page("Not found", "<h1>Unknown dashboard</h1>")); return; }
    const rows = ctx.events.latest(t.id, 20)
      .map((e) => `<tr><td>${new Date(e.at).toISOString()}</td><td>${e.kind}</td><td>${e.detail}</td></tr>`)
      .join("");
    res.send(page(`Dashboard — ${t.label}`, `
      <h1>${t.label}</h1>
      <p>Status: ${t.enabled ? "enabled" : "disabled"} · Waker: ${t.wakerEnabled ? "on" : "off"} · Provider: ${t.provider}</p>
      <form method="post" action="/dashboard/${t.token}/toggle">
        <button name="what" value="enabled">Toggle enabled</button>
        <button name="what" value="waker">Toggle waker</button>
      </form>
      <table><tr><th>Time</th><th>Event</th><th>Detail</th></tr>${rows}</table>`));
  });

  router.post("/dashboard/:token/toggle", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const what = (req.body as { what?: string }).what;
    if (what === "enabled") ctx.tenants.setEnabled(t.id, !t.enabled);
    if (what === "waker") ctx.tenants.setWaker(t.id, !t.wakerEnabled);
    res.redirect(`/dashboard/${t.token}`);
  });

  return router;
}
```

- [ ] **Step 4: Run tests green**
- [ ] **Step 5: Commit** — `git commit -am "feat: portal — validated onboarding, tool auto-provision, health dashboard"`

---

### Task 12: Boot wiring + MOCK mode + E2E smoke

**Files:**
- Create: `src/mock/fakes.ts`, `src/http/app.ts`, `src/index.ts`
- Test: `test/e2e-mock.test.ts`

**Interfaces:**
- Produces: `src/mock/fakes.ts` — `mockV3Factory()`, `mockGhlFactory()`, `mockProviderFactory()`, `mockMediaFetch` (serves an OggS byte payload for any msgsndr URL). The mock v3 holds an in-memory conversation `mock-conv-1` (assistant `mock-asst-1`, contact `mock-contact-1`) whose message list starts with one media-only inbound row; `chatCompletion` marks a `wokenConversations` set inspectable by tests.
- Produces: `buildApp(config): { app: Express; stores; wireDeps }` — mounts tool, mcp, portal routers with real or mock factories per `config.mock`; JSON body parsing before routers; urlencoded for portal.
- Produces: `src/index.ts` — loadConfig → openDb(config.dbPath) → buildApp → listen(port) → startWaker(interval 25 000 ms, `WAKER_INTERVAL_MS` override) → hourly `processed.prune(7 days)` interval.
- E2E (MOCK): onboard via `POST /setup` → run one waker cycle manually (primed cursor then bumped fake conversation) → assert wake happened → POST the tool envelope → assert result text flows.

- [ ] **Step 1: Write failing E2E test**

`test/e2e-mock.test.ts`:

```ts
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildApp } from "../src/http/app";
import { runWakerCycle } from "../src/core/waker";

process.env.MOCK_MODE = "1";
process.env.DB_PATH = ":memory:";

describe("mock-mode e2e", () => {
  it("onboards, wakes on media-only, and serves the tool call", async () => {
    const { app, wireDeps } = buildApp(loadConfig());

    // 1. Onboard
    const setup = await request(app).post("/setup").type("form").send({
      label: "MockVol", locationId: "mock-loc-1", assistantId: "mock-asst-1",
      provider: "gemini", v3Key: "any", ghlPit: "any", aiKey: "any",
    });
    expect(setup.status).toBe(200);
    const token = /\/mcp\/([a-f0-9]{48})/.exec(setup.text)?.[1];
    expect(token).toBeTruthy();
    const tenant = wireDeps.tenants.getByToken(token as string);
    expect(tenant).toBeTruthy();

    // 2. Waker: prime, bump, detect, wake
    const wakerDeps = wireDeps.wakerDepsFor(tenant!);
    await runWakerCycle(wakerDeps, tenant!);          // prime
    wireDeps.mockV3State.bumpConversation();          // media-only message arrives
    const r = await runWakerCycle(wakerDeps, tenant!);
    expect(r.woken).toBe(1);
    expect(wireDeps.mockV3State.wokenConversations.has("mock-conv-1")).toBe(true);

    // 3. Tool call (what the woken assistant does next)
    const tool = await request(app).post(`/tool/${token}`).send({
      args: {}, meta_data: { contact_id: "mock-contact-1", location_id: "mock-loc-1" },
    });
    expect(tool.status).toBe(200);
    expect(tool.body.result).toContain("Voice note transcript");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement**

`src/mock/fakes.ts`:

```ts
import type { Tenant } from "../store/tenants";

const OGG = new Uint8Array([...new TextEncoder().encode("OggS"), 0, 1, 2, 3]);

export function createMockState() {
  let convUpdatedAt = "2026-07-23T10:00:00Z";
  const wokenConversations = new Set<string>();
  const mediaMessages = [
    { id: "vmsg-1", content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t1" },
  ];
  return {
    wokenConversations,
    bumpConversation() { convUpdatedAt = "2026-07-23T11:00:00Z"; },
    v3Factory: () => ({
      validateKey: async () => true,
      listAssistants: async () => [{ id: "mock-asst-1", name: "Mock Bot" }],
      createTool: async () => ({ id: "mock-tool-1", raw: {} }),
      listConversations: async () => [
        { id: "mock-conv-1", contactId: "mock-contact-1", updatedAt: convUpdatedAt,
          assistant: { id: "mock-asst-1" } },
      ],
      listMessages: async () => mediaMessages,
      chatCompletion: async (a: { conversationId: string }) => {
        wokenConversations.add(a.conversationId);
        return { ok: true as const };
      },
    }),
    ghlFactory: (_tenant?: Tenant) => ({
      validatePit: async () => true,
      latestMediaMessages: async () => [
        { id: "gmsg-1", attachments: ["https://storage.msgsndr.com/mock.ogg"],
          direction: "inbound", dateAdded: "t1" },
      ],
    }),
    providerFactory: () => ({
      describe: async (i: { kind: string }) =>
        i.kind === "audio" ? "hey, can I move my appointment to Friday?" : "a photo of a receipt",
      validateKey: async () => true,
    }),
    mediaFetch: (async () => new Response(OGG)) as unknown as typeof fetch,
  };
}
```

`src/http/app.ts`:

```ts
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
      mockV3State: mock ?? { wokenConversations: new Set<string>(), bumpConversation() {} },
    },
  };
}
```

`src/index.ts`:

```ts
import { loadConfig } from "./config";
import { runWakerCycle, startWaker } from "./core/waker";
import { buildApp } from "./http/app";

const config = loadConfig();
const { app, wireDeps } = buildApp(config);

app.listen(config.port, () => {
  console.log(`media-mcp listening on :${config.port} (mock=${config.mock})`);
});

const intervalMs = Number(process.env.WAKER_INTERVAL_MS ?? 25_000);
startWaker(
  (t) => runWakerCycle(wireDeps.wakerDepsFor(t), t),
  () => wireDeps.tenants.list(),
  intervalMs
);
setInterval(() => wireDeps.processed.prune(7 * 24 * 60 * 60 * 1000), 60 * 60 * 1000).unref();
```

- [ ] **Step 4: Run full suite green** — `npm test && npm run typecheck`
- [ ] **Step 5: Commit** — `git commit -am "feat: app wiring, mock mode, e2e smoke — full loop green"`

---

### Task 13: Spike CLI (live verification harness)

**Files:**
- Create: `src/spike.ts`
- Test: none (thin CLI over already-tested clients; verified live by Hari)

**Interfaces:**
- Consumes: `createV3Client`, `createGhlClient`, `downloadMedia`, `sniff`, `WAKE_INSTRUCTION`.
- Produces: `npm run spike -- <command>` reading env `SPIKE_V3_KEY`, `SPIKE_GHL_PIT`, `SPIKE_LOCATION_ID`, `SPIKE_ASSISTANT_ID`:
  - `detect` — poll conversations every 5 s for 2 min, print any media-signature rows with timestamps (measures ingest lag against when the tester sends the voice note).
  - `fetch <contactId>` — PIT media lookup, print raw attachment URLs, attempt download, print sniffed type + byte counts. Prints RAW GHL JSON on shape mismatch.
  - `wake <conversationId>` — send chat/completions with `WAKE_INSTRUCTION`, print status. Success criterion: the reply arrives on the tester's phone.
  - `tool-listen` — start a bare Express server on :4001 that prints every request body verbatim (used as a temporary tool URL to capture the REAL envelope + meta_data keys).

- [ ] **Step 1: Implement**

```ts
import express from "express";
import { createGhlClient } from "./clients/ghl";
import { createV3Client } from "./clients/v3";
import { WAKE_INSTRUCTION } from "./core/waker";
import { downloadMedia } from "./media/download";
import { sniff } from "./media/sniff";

const [cmd, arg] = process.argv.slice(2);
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
  return v;
};
const v3 = () => createV3Client({
  baseUrl: process.env.V3_BASE_URL ?? "https://app.assistable.ai",
  apiKey: env("SPIKE_V3_KEY"),
});
const ghl = () => createGhlClient({
  baseUrl: process.env.GHL_BASE_URL ?? "https://services.leadconnectorhq.com",
  pit: env("SPIKE_GHL_PIT"),
});

async function main() {
  if (cmd === "detect") {
    console.log("Polling for media-signature messages for 2 minutes — send the voice note NOW.");
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const convs = await v3().listConversations(10);
      for (const c of convs) {
        const msgs = await v3().listMessages(c.id);
        for (const m of msgs) {
          if (m.source === "USER" && !m.ai && (!m.content || !m.content.trim()) && !seen.has(m.id)) {
            seen.add(m.id);
            console.log(`${new Date().toISOString()} DETECTED conv=${c.id} msg=${m.id} channel=${m.channel} createdAt=${m.createdAt}`);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else if (cmd === "fetch") {
    const rows = await ghl().latestMediaMessages({
      locationId: env("SPIKE_LOCATION_ID"), contactId: arg ?? env("SPIKE_CONTACT_ID"),
    });
    console.log(JSON.stringify(rows, null, 2));
    for (const r of rows) for (const url of r.attachments) {
      const dl = await downloadMedia(url);
      console.log("error" in dl
        ? `DOWNLOAD FAILED ${url}: ${dl.error}`
        : `OK ${url} → ${dl.bytes.length} bytes, sniffed ${JSON.stringify(sniff(dl.bytes))}`);
    }
  } else if (cmd === "wake") {
    const r = await v3().chatCompletion({
      assistantId: env("SPIKE_ASSISTANT_ID"), conversationId: arg ?? env("SPIKE_CONVERSATION_ID"),
      additionalInstructions: WAKE_INSTRUCTION,
    });
    console.log(r.ok ? "WAKE SENT — watch the phone for the assistant's reply." : `WAKE FAILED: ${r.error}`);
  } else if (cmd === "tool-listen") {
    const app = express();
    app.use(express.json());
    app.all("*", (req, res) => {
      console.log("--- envelope received ---");
      console.log(JSON.stringify({ path: req.path, body: req.body }, null, 2));
      res.json({ result: "spike listener says hello" });
    });
    app.listen(4001, () => console.log("tool-listen on :4001 — point a test tool at this URL"));
  } else {
    console.log("Usage: npm run spike -- detect | fetch <contactId> | wake <conversationId> | tool-listen");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it compiles and mock-runs** — `npm run typecheck`; `npm run spike -- help` prints usage.
- [ ] **Step 3: Commit** — `git commit -am "feat: spike cli — detect/fetch/wake/tool-listen live verification"`

---

### Task 14: Deploy config + README/runbook

**Files:**
- Create: `render.yaml`, `README.md`

**Interfaces:** none (docs + config only).

- [ ] **Step 1: Write `render.yaml`**

```yaml
services:
  - type: web
    name: media-mcp
    runtime: node
    plan: starter
    buildCommand: npm ci && npx tsc
    startCommand: node dist/index.js
    disk:
      name: media-mcp-data
      mountPath: /data
      sizeGB: 1
    envVars:
      - key: MOCK_MODE
        value: "0"
      - key: DB_PATH
        value: /data/media-mcp.sqlite
      - key: ENCRYPTION_KEY
        sync: false
      - key: PUBLIC_BASE_URL
        sync: false
```

- [ ] **Step 2: Write `README.md`** covering: what it is (one paragraph + the three doors), local dev (`MOCK_MODE=1 npm run dev`), test (`npm test`), the volunteer onboarding steps (3 pastes + prompt snippet), the spike runbook (detect → fetch → wake → tool-listen, with the success criterion "the assistant's reply reaches the phone"), the kill switches, and the privacy posture (no media persistence). Include the PIT scopes checklist: `conversations.readonly`, `conversations/message.readonly`.

- [ ] **Step 3: Commit** — `git commit -am "chore: render deploy config + README/runbook"`

---

## Live-integration checklist (after volunteer credentials arrive — not code tasks)

1. `npm run spike -- detect` while the volunteer sends a WhatsApp voice note → ingest lag measured, signature confirmed.
2. `npm run spike -- fetch <contactId>` → attachment URL downloads, sniffs as audio.
3. `npm run spike -- wake <conversationId>` → assistant reply reaches the phone.
4. `npm run spike -- tool-listen` + a manually-created test tool → captures the REAL envelope; if `meta_data` keys differ from `contact_id`/`location_id`, update `readContext()` in `src/http/tool.ts` (one function, tests updated to the real casing).
5. Onboard the volunteer through the deployed portal; send each modality; verify replies; check the dashboard health panel.

## Self-review notes

- Spec coverage: three doors (Tasks 8, 9, 10), portal + auto-provision (11), BYO adapters (6), privacy/no-persist (core holds bytes in memory only; events log counts not content), kill switches (tenant + waker toggles, Task 11), MOCK-mode E2E (12), spike harness (13), deploy (14). PDF is sniffed and routed (Gemini) with OpenAI returning the documented notice — matching the spec's "PDF fast-follow" without leaving it broken.
- Type consistency: `Tenant`, `TenantStore.setToolId/setWaker`, `WakerDeps`, `AnalyzeDeps`, `runWakerCycle`, `WAKE_INSTRUCTION`, provider `describe` signature are each defined once and consumed by name in later tasks.
- Known deliberate simplifications (MVP): waker cursor is in-memory (restart = one prime cycle, no storm, dedupe prevents re-wakes); portal has no accounts (unguessable 48-hex token per tenant); no queue (volumes are per-pilot).
