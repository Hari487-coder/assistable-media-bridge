# Media MCP Bridge

A Model Context Protocol service that connects Assistable v3 assistants to media attachments (voice notes, images, documents) sent through GHL subaccounts.

When a contact sends a voice note, photo, or document via WhatsApp/SMS/email into GHL, the assistant can now read it—automatically waking and analyzing on detect, or on-demand through the tool.

## Deploy your own in 3 steps

You run your own copy. Nothing is shared or hosted centrally, and no one else can see your data.

### Step 1 — Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Hari487-coder/assistable-media-bridge)

Click the button, connect your Render account, hit **Apply**. Render reads `render.yaml` and provisions everything with **zero configuration** from you:

- Encryption key: **auto-generated** (unique to your instance).
- Public URL: **auto-detected**. A 1 GB disk holds your database. Starter tier is fine.

Wait for the build to go green, then open your new `https://<your-name>.onrender.com`.

### Step 2 — Connect

You land on the onboarding portal. Paste **your own** keys (they are validated live and stored encrypted on **your** instance only):

- GHL **Location ID** + default **assistant ID**
- **Assistable v3 API key**
- **AI provider key** — Gemini (recommended, free tier covers audio + images + PDFs) or OpenAI
- A **read-only GHL Private Integration Token** (scopes: `conversations.readonly`, `conversations/message.readonly`)

On success the `analyze_attachment` tool is auto-created in your assistant, and you get a prompt snippet to paste plus your private dashboard link.

### Step 3 — Test

Send a **voice note with no caption** to your number. The assistant reads it and replies. Watch the poll → detect → wake → tool events stream live on your dashboard.

## Three Doors

1. **Portal** (`/`, `/setup`, `/dashboard/:token`) — Volunteers connect their GHL location to an Assistable v3 assistant. Credentials are validated live. Kill switches (enable/disable bridge, waker, modalities) live on the dashboard.
2. **MCP Server** (`/mcp/:token`) — Stateless Model Context Protocol endpoint. Assistants call one of four tools: `analyze_attachment`, `transcribe_audio`, `analyze_image`, `read_document`.
3. **Tool Endpoint** (`/tool/:token`) — Direct HTTP interface for the analyze_attachment tool. Can be wired as a custom tool in Assistable v3 (auto-created on successful onboarding).

## Local Development

```bash
MOCK_MODE=1 npm run dev
```

This runs the service on `:3900` in mock mode:
- Portal: http://localhost:3900
- MCP server accepts requests at `/mcp/<token>` (use `test-token` in mocks)
- Spike CLI works with hardcoded test data

## Testing

```bash
npm test
```

Runs the full test suite covering stores, crypto, clients, media sniff/download, provision, waker, portal, MCP server, tool endpoint, and MOCK E2E.

```bash
npm run typecheck
```

Verifies TypeScript types.

## Onboarding a Volunteer

Visit the portal (or Render deployment) and fill the form:

1. **Subaccount** — label, GHL location ID, default assistant ID
2. **Credentials** — three pastes:
   - Assistable v3 API key (from `/api-keys` in the dashboard)
   - GHL Private Integration Token (from the location's integrations page)
   - AI provider API key (Gemini or OpenAI)
3. **Provider selection** — Gemini (recommended) or OpenAI

The portal validates all credentials live before saving. On success, you get:
- **MCP endpoint** — copy into the assistant's MCP server config
- **Tool URL** — either auto-provisioned as `analyze_attachment` or manual (CUSTOM tool in Assistable v3)
- **Prompt snippet** — add to the assistant's system prompt:
  ```
  If the contact sends, or refers to, a photo, image, screenshot, document, or voice note, ALWAYS call the analyze_attachment tool first to read it, then respond based on its content. Never say you cannot open attachments.
  ```

GHL PIT must have these scopes:
- `conversations.readonly`
- `conversations/message.readonly`

## Spike Runbook (Testing Integration)

The `npm run spike` CLI tests the full detect→fetch→wake→tool-listen flow.

### Step 1: Detect media signature

```bash
SPIKE_V3_KEY=your-key npm run spike -- detect
```

Have a volunteer send a WhatsApp voice note. The CLI polls v3 for 2 minutes and logs:
```
2026-01-15T14:32:18.123Z DETECTED conv=c_abc msg=m_xyz channel=whatsapp createdAt=1234567890
```

Record the `contactId` from the GHL side (in the dashboard or via `SPIKE_LOCATION_ID`).

### Step 2: Fetch media from GHL

```bash
SPIKE_LOCATION_ID=loc_... SPIKE_CONTACT_ID=con_... SPIKE_GHL_PIT=token npm run spike -- fetch
```

This downloads attachments from the contact's latest messages and sniffs them:
```
OK https://...jpg → 45123 bytes, sniffed {"kind":"image","mime":"image/jpeg"}
```

### Step 3: Wake the assistant

```bash
SPIKE_V3_KEY=key SPIKE_ASSISTANT_ID=asst_... SPIKE_CONVERSATION_ID=c_abc npm run spike -- wake
```

This sends `WAKE_INSTRUCTION` to the assistant, requesting it call `analyze_attachment` immediately.

**Success criterion:** The assistant's reply reaches the phone (WhatsApp, SMS, or email, depending on the channel).

### Step 4: Tool listener (for custom tool testing)

```bash
npm run spike -- tool-listen
```

Starts a debug server on `:4001` that logs all POST bodies. Point a test tool at `http://localhost:4001` to capture the real envelope. If `meta_data` keys differ from `contact_id`/`location_id`, update `readContext()` in `src/http/tool.ts`.

## Kill Switches

All toggles live on the dashboard (`/dashboard/:token`):

- **Enable/disable bridge** — pauses all processing without wiping data
- **Waker on/off** — turn automatic wake-on-detect on/off (tool endpoint still works)
- **Voice notes on/off** — silence audio analysis
- **Images on/off** — silence image analysis

Waker also respects per-tenant flags set via `TenantStore.setWaker()` and per-modality toggles set via `setModality()`.

## Privacy & No-Persist Model

**Media bytes are never stored:**
- Downloaded attachments are held in memory only, passed to the provider (Gemini or OpenAI), and discarded
- Events log counts and metadata (kind, mime, timestamp, tenantId), not content
- Conversation/message IDs are cached in-memory for wake detection only (waker cursor resets on restart)

Credentials (v3 API key, GHL PIT, provider API key) are encrypted at rest in SQLite using `ENCRYPTION_KEY` and decrypted on read.

**In production:**
- `ENCRYPTION_KEY` must be a 64-character hex string (set via Render secrets)
- `PUBLIC_BASE_URL` must match the deployed domain for MCP and tool URLs to be correct
- `MOCK_MODE` must be `0` (or unset)

## Portal Provision Warnings

If modalities cannot be read from GHL (e.g., PIT lacks permissions), the dashboard shows a warning pill. The bridge still works; the assistant can always call the tool, but automatic modality flags may not reflect reality.

## Architecture Notes

- **Stores:** Tenants (in-memory + SQLite), Events (SQLite), Processed (in-memory, auto-pruned every hour)
- **Waker:** Runs every 25s (configurable via `WAKER_INTERVAL_MS`). Cursor is in-memory; restart causes one prime cycle (no storm due to dedup).
- **Providers:** Gemini (raw REST call to `generativelanguage.googleapis.com`, handles audio/image/PDF) and OpenAI (Whisper for audio, `gpt-4o-mini` vision for images; PDF unsupported). No provider SDK dependency — plain `fetch`. Each implements `describe({ kind, mime, bytes })` → text on the customer's BYO key.
- **Crypto:** AES-256-GCM for credential encryption at rest; one fixed master key (`ENCRYPTION_KEY`), a fresh random IV on every write.

## Deployment

See `render.yaml` for Render web service config:

```yaml
services:
  - type: web
    name: media-mcp
    runtime: node
    buildCommand: npm ci && npx tsc
    startCommand: node dist/src/index.js
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

Build emits to `dist/src/` (TypeScript preserves directory structure). Start command is `node dist/src/index.js`.

Before going live, verify:
1. `npm test` is green (full suite)
2. `npm run spike -- detect`, `fetch`, `wake`, `tool-listen` work with real credentials
3. Dashboard health panel shows recent activity after an attachment is sent
