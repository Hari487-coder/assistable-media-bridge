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

## Onboarding an Agency (many subaccounts)

One instance serves any number of subaccounts. `/setup/batch` takes the three
credentials **once** and a list of subaccounts, one per line:

```
subAccountId, locationId, assistantId, label
```

**`subAccountId` and `locationId` are two different ids.** They sit on the same
record but hold different values: `SubAccount.id` is Assistable's own cuid,
`SubAccount.locationId` is the CRM's. Take the subaccount id from the dashboard
URL while inside it, `/portal/<subAccountId>/...`. Pasting the location id into
both columns is the usual slip, so it is rejected up front with an explanation
rather than failing four API calls later as "assistant is not visible to this v3
API key".

Commas or tabs, so a spreadsheet column paste works unchanged. Only the first
two fields are required — leave the assistant blank and it is filled in
automatically when that subaccount has exactly one; if it has several the row
fails listing the choices rather than guessing and wiring media into the wrong
bot. The label defaults to the location id.

The v3 API key must be **workspace-wide**, since every row is provisioned
against its own `X-Subaccount-Id`. A key scoped to a single subaccount cannot
reach the others.

### GHL tokens: shared, per-location, or mixed

A GHL Private Integration may be agency-wide or scoped to a single location
depending on how it was minted, and the token itself does not say which. So the
list supports both instead of assuming:

```
# one agency token for everything — paste it in Shared credentials
sub_a1b2, loc_9f8e, asst_1234, Main Street Dental

# this location needs its own
sub_c3d4, loc_7a6b, , Riverside Chiropractic, pit=pit-abc123
```

`pit=<token>` may appear in any position in a row and overrides the shared
token for that location only. It is keyed rather than a fifth positional column
because the label deliberately absorbs trailing commas (`Main Street Dental,
PC`), which a positional token would be ambiguous with.

Leave the shared field blank if every location has its own. Each row is checked
independently: a row with no token from either source fails alone, saying so.

If a submission is rejected the list is echoed back so you can fix it in place,
but `pit=` values are stripped first — a live token should not be written into
an HTML response that a proxy or log might retain. Re-add them before
resubmitting.

Each row runs through the same validation, tool creation and reconnect path as
the single form, four at a time, and a failing row never aborts the batch. So
the workflow is: paste the list, fix whatever failed, paste the **whole list**
again. Rows that already succeeded reconnect in place — same token, same live
tool URL, same activity history — instead of duplicating.

Onboarding is keyed on the GHL location: one tenant per location, enforced by a
unique index. That matters because two rows for one location means two waker
cursors, so the contact gets two AI replies and every attachment is billed to
the AI provider twice.

Each connected subaccount still gets its own dashboard, kill switches and
`analyze_attachment` tool; the prompt snippet must be added to every assistant.

### Subaccounts running several assistants

**One row per location, regardless of how many assistants it runs.** A second
row for the same location does not create a second connection — it reconnects
and replaces the first.

It is not needed anyway. Wakes go to the conversation's *own* assistant, not the
tenant's, and the tool is attached to that assistant on the way past:

```
const assistantId = conv.assistant?.id ?? tenant.assistantId;
await ensureToolAssigned(deps, tenant, assistantId);
```

The `assistantId` in a row is only the fallback for conversations with no
assistant of their own.

That attachment is lazy — an assistant gets the tool the first time it receives
an attachment. So an assistant that has never been sent one cannot yet answer
"did you see the photo I sent?" asked as plain text. Lazy is the default on
purpose: a voice-only or sales assistant should not silently gain the ability to
read attachments because someone onboarded a location.

**Attach tool to all assistants** on the dashboard closes that gap on demand,
attaching it to every assistant in the subaccount in one press and recording the
per-assistant outcome in the activity feed.

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

## Emoji and Reactions

Emoji inside a normal message (`👍 thanks, see you Friday`) reach the assistant
normally — the body is non-empty, so nothing drops it.

A **reaction** is different. Tapping 👍 on a message sends no body, and the
platform drops every body-less inbound before the AI (`enrich.worker.ts`, whose
own log names the cases: "reaction / sticker / media-only / unsupported type").

**The assistant is never woken for a reaction.** A reaction usually means the
conversation is finished, and replying to every thumbs-up is both chatty and a
model call per tap.

What the bridge does need to do is not *mistake* one for an attachment. Body-less
inbound messages are split on the v3 `type` field:

| `type` | Treated as |
| --- | --- |
| `IMAGE` / `AUDIO` / `FILE` / `VIDEO` | media — wake the assistant to read it |
| anything else (e.g. `TEXT`) | reaction — recorded and ignored |
| missing | media |

Without that split, a reaction was woken as if an attachment had arrived: the
assistant called `analyze_attachment`, got "no new attachments", and improvised.
That confused reply is what a contact experiences as the AI answering an emoji
with nonsense.

Reactions are still marked processed, so the same tap is not re-detected every
cycle, and a burst mixing a photo with a reaction still wakes on the photo. The
`detect` event records them (`reactions=1 (ignored)`) so they are visible on the
dashboard without generating traffic.

## Telling the Reader What to Look For

By default the reader does generic extraction: verbatim transcript for audio,
full OCR plus a one-line description for images, full text plus a summary for
PDFs. That reliably captures the headline figure on a receipt and routinely
garbles the small print — a reference id, a last-4, a bank name.

The dashboard has an **Extra guidance** box per subaccount. Whatever you put
there is appended to the built-in prompt on every attachment, on all three
doors:

```
Receipts are common here. Always extract the amount, currency, date,
payer name and any reference or transaction number.
```

The built-in prompt always goes first, so guidance adds focus and never
replaces the base extraction. Capped at 500 characters, since it rides on every
provider call. It is an operational setting like the kill switches, so
re-onboarding the location does not wipe it.

> **This changes what the reader extracts, not what is true.** A receipt
> screenshot takes seconds to fake and vision models misread digits. Use the
> output to *populate* a payment check, never to *be* one — confirm against the
> payment provider or invoice record before the assistant tells a customer
> anything is paid.

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
- **Waker:** Polls every `WAKER_INTERVAL_MS` (default 25s), `WAKER_CONCURRENCY` tenants at a time (default 4). Cursor is in-memory; restart causes one prime cycle (no storm due to dedup).
- **Timeouts:** every v3 and GHL request carries a 15s abort signal. A hung request is worse than a failed one — it holds a waker slot indefinitely and stalls the tenants queued behind it.

### Waker tuning

| Variable | Default | What it does |
| --- | --- | --- |
| `WAKER_INTERVAL_MS` | `25000` | How often a poll pass starts |
| `WAKER_CONCURRENCY` | `4` | Tenants polled at once (1–32) |
| `WAKER_BUDGET_MS` | `20000` | Wall-clock ceiling for one tenant's cycle |

Passes never overlap: if one runs long the next tick is skipped, so the
*effective* interval silently stretches. Two things make that visible instead:

- **Pass overran** — the service log warns whenever a pass takes longer than
  `WAKER_INTERVAL_MS`, naming the duration and tenant count. That is the signal
  to raise `WAKER_CONCURRENCY`.
- **`poll_budget` event** — one tenant with a large backlog would otherwise hold
  its slot for minutes. At `WAKER_BUDGET_MS` its cycle pauses and the event says
  how far it got. Nothing is lost: the cursor only advances past conversations
  that actually finished, so the remainder resumes next cycle. At least one
  conversation is always processed per cycle, so progress is guaranteed even if
  the budget is set below a single round-trip.

Rough sizing: one pass costs roughly `tenants / concurrency` round-trips of
latency in the quiet case. At the defaults, ~40 tenants still fits inside 25s.

### How much traffic this generates

One `GET /v3/conversations` per connected subaccount per interval. At the
defaults that is **one request every 25 seconds per subaccount** — three
connected locations produce three requests every 25s, which is what a customer
sees as a steady beat in their API request log. That is the polling design, not
a loop.

If a key is revoked, those polls start failing 401. After three consecutive
authentication failures the waker **pauses that tenant** and records why. The
pause is persisted, so a restart does not resume hammering a dead key; turning
the waker back on is a deliberate click once the key is fixed. Transient
failures (500, 429, timeouts) never pause a tenant — retrying is the correct
response to those.
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
