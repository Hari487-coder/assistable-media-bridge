# Media MCP — Media Understanding for Assistable (Design Spec)

**Date:** 2026-07-23 (rev 3 — adds the Custom Tool leg; one processing core, three doors)
**Status:** Approved (owner: "let's build it"); live-integration items verified by spike harness during build
**Owner:** Hari · **Pilot:** volunteer design partner connects their own subaccount + keys
**Project dir:** `Case Study/assistable-media-bridge`

## Problem

Assistable assistants cannot understand non-text messages. Verified in platform source:

- Media-only inbound messages (image/PDF/voice note, no caption) are silently dropped
  before the AI runs — `enrich.worker.ts:479` (`empty_inbound_body`) and
  `agent-run.ts:468` (null-content filter). The assistant is never invoked.
- The drop happens BEFORE the `message.received` webhook emission
  (`enrich.worker.ts:1222`) — platform webhooks never fire for media-only messages,
  and their payload has no attachments anyway.
- Attachment URLs are persisted on the Message row but nothing consumes them; no v3
  read route exposes them (`MESSAGE_SELECT` omits `attachments`).
- GHL attachment URLs go stale (`call-events.ts:2487` — 403/dead links): always
  fetch a fresh URL at processing time.
- Captioned media DOES wake the AI (body non-empty) but the AI cannot see the
  attachment. The chat widget has NO attachment upload support at all
  (`chat-stream.ts` — nothing to analyze there until the platform adds uploads;
  the tool leg covers it automatically when that happens).

Native fix "in development", no ETA.

## Constraints (hard, from owner)

1. Fully self-serve portal (live-KB pattern); nothing operated per-customer.
2. **Strict BYO AI key** (Gemini default; guided key-creation flow).
3. Setup = a few clicks/pastes, validated live.
4. All media types (image, PDF, voice/audio) across all channels where media can
   arrive (SMS/MMS, WhatsApp, FB, IG — all flow through the same GHL
   `Message.attachments` path, so ONE mechanism covers all of them).
5. No Assistable platform changes required.
6. Media-only messages MUST work.
7. **MCP is the product's interface**; must plug into Assistable's announced
   native MCP support the day it ships.

## Architecture: one processing core, three doors

```
                 ┌────────────────────── Media MCP service ──────────────────────┐
                 │                                                               │
 DOOR 1          │   PROCESSING CORE                                             │
 Custom Tool ───►│   resolve tenant → locate media (GHL fetch, fresh URL,        │
 (assistant      │   via PIT; contactId+locationId from tool meta_data)          │
 calls it        │   → download (allowlist, caps, magic-byte sniff)              │
 mid-run, any    │   → route on tenant BYO key:                                  │
 channel,        │       audio→transcribe · image→vision/OCR · PDF→extract       │
 captioned or    │   → return extracted text                                     │
 woken)          │                                                               │
                 │                                                               │
 DOOR 2          │   WAKER (per tenant, ~20–30s poll, tenant v3 key)             │
 media-only ────►│   poll /api/v3/conversations?sort=newest → changed convos     │
 messages        │   → GET /api/v3/conversations/:id/messages                    │
 (the drop bug)  │   → source=USER + ai=false + empty content = media signature  │
                 │   → dedupe → POST /api/v3/chat/completions                    │
                 │     { assistant_id, conversation_id, additional_instructions: │
                 │       "<marker> contact sent an attachment — call the         │
                 │        analyze_attachment tool, then respond" }               │
                 │   → executeAgentRun (chat.ts:72): FULL pipeline (takeover,    │
                 │     sleep windows, billing, tracing, GHL send)                │
                 │   → assistant calls the tool (Door 1) → replies               │
                 │                                                               │
 DOOR 3          │   MCP SERVER (Streamable HTTP)                                │
 MCP clients ───►│   tools: analyze_attachment · transcribe_audio ·              │
 (workflow       │          analyze_image · read_document · status               │
 builder MCP     │   Callable today: v2 workflow-builder MCP node, Claude,       │
 node today;     │   Cursor. Tomorrow: assistants natively (announced feature)   │
 assistants      │   → waker retires per tenant = graduation, not decommission   │
 when native     │                                                               │
 MCP ships)      │   PORTAL (live-KB pattern) + tenant store (encrypted)         │
                 └───────────────────────────────────────────────────────────────┘
```

### Why the tool leg works with API-created tools (source-verified)

`executionType` ("Direct") only controls the upstream **body shape** — raw args vs
the `{args, meta_data, metadata, call}` envelope (`tool-proxy.service.ts:25-36,95-106`).
**Every** tool's upstream HTTP response is returned verbatim into the run
(chat executes in-process via `executeProxiedTool`). So a CUSTOM tool created via
`POST /api/v3/tools` (no `executionType` field exposed — fine) is synchronous out
of the box; our endpoint simply accepts the envelope format: `body.args` +
`body.meta_data` (carries `locationId`, `contactId` — built in `agent-run.ts:915-924`).
The old "Direct Request is DB-only" concern applied to raw-body mode only — not
to result return. Risk dissolved.

### Tool-leg context bonus

The extracted text returns as a tool result inside the run and persists in
conversation history (tool trace) — follow-up turns see it. This addresses what
SPIKE-3 was for; `/v3/messages` (source API) persistence remains an optional
enhancement, not a dependency.

### Decision log (dead routes, source-verified)

- **GHL inbound-message injection** — fabricated contact-attributed messages fire
  phantom "Customer Replied" automations, double-reply on captioned media,
  pollute CRM history (council 2026-07-22).
- **GHL Marketplace app for detection (rev 1)** — replaced by v3 polling; cut
  marketplace review, OAuth infra, webhook infra.
- **Platform `message.received` webhook trigger** — emitted after the empty-body
  drop; never fires for media-only.
- **Workflow triggers as detector** — WEBHOOK/MANUAL/SCHEDULE only; no message
  trigger. (Workflow MCP node remains a Door-3 consumer.)
- **Watcher processes media itself (rev 2)** — superseded: waker now only wakes;
  all processing consolidated behind Door 1 (single code path, tool-trace
  context persistence for free).

## Onboarding (portal, live-KB pattern — volunteer pilot flow)

Three validated pastes, then automatic provisioning:

1. **Assistable v3 API key** — validated live; used by waker + injection +
   tool auto-creation. Auth: `Authorization: Bearer <key>` against
   `https://app.assistable.ai/api/v3/...` (base URL from the platform's own
   MCP config, `apps/mcp-server/src/config.ts`).
2. **AI provider key** — Gemini (default; audio+vision+PDF, free tier) or
   OpenAI (Whisper + vision); Anthropic image/PDF-only (audio marked
   unsupported). Guided key-creation walkthrough. Validated with a live call.
3. **GHL Private Integration Token** — read-only conversation scopes (exact
   checklist shown); used only to fetch fresh media URLs/bytes.

Then the portal **auto-provisions** via their v3 key:
- Creates the `analyze_attachment` CUSTOM tool in their subaccount
  (`POST /api/v3/tools`: url → our endpoint with per-tenant token, parameters:
  none required — meta_data carries context; description tells the LLM when to
  call it).
- Shows a copy-paste **prompt snippet** for their assistant ("If the contact
  sends or mentions an attachment/photo/voice note, call analyze_attachment...").
- User picks the default assistant (fetched via `GET /api/v3/assistants`) for
  waker injections.
- Per-location controls: modality toggles, waker on/off, tool on/off (kill
  switches), health panel (last poll/detection/wake/tool call/error, key status).

## Key behaviors & policies

- **Coverage matrix (MVP):** media-only messages (waker→tool) + captioned media
  (prompt-driven tool call) on all GHL channels. Chat widget: no uploads exist
  platform-side; tool leg covers it automatically if/when uploads ship.
- **Media targeting:** tool fetches the contact's latest inbound message(s) with
  attachments via GHL (conversation search by contactId), newest first, first 3
  attachments attempted per call; excess is deliberately dropped with an honest
  count note (never deferred — stale media retried later would confuse the
  conversation); dedupe by message id.
- **Latency:** captioned media ≈ instant (in-run tool call). Media-only ≈ poll
  interval + one extra model round-trip (< ~1 min; today's behavior is silence).
- **Failure fallback (per-tenant toggle, default on):** unreadable media → tool
  returns a graceful "attachment couldn't be read" result so the assistant still
  responds; waker never re-fires for the same message (dedupe persists across
  restarts).
- **Idempotency & loop safety:** processed-message set (SQLite, TTL); waker
  matches only inbound USER + empty-content rows — its own injections and
  assistant replies never match the signature.
- **Privacy:** media processed in memory only; no bytes/transcripts persisted;
  no media content in logs; keys/PITs AES-256-GCM at rest.
- **Billing (documented):** media replies draw the customer's Assistable wallet
  + their provider costs. Waker adds one completion per media-only message.
- **Rate-limit citizenship:** poll cadence tuned to `v3RateLimit` budget
  (measured during spike); message fetches only for changed conversations.

## Spike harness (built first, run when volunteer creds arrive)

CLI (`spike detect` / `spike fetch` / `spike wake` / `spike tool`) verifying with
real credentials: (a) media signature visible via v3 + ingest lag; (b) PIT fetch
returns downloadable fresh attachment URLs; (c) chat/completions wake → assistant
calls the tool → reply reaches the phone; (d) tool envelope shape + meta_data
fields as expected. These are verification items, not design gates — the
architecture builds in MOCK mode in parallel; live wiring flips on after the
spike passes against the volunteer subaccount.

## MVP cut

Voice notes + images (PDF fast-follow), media-only + captioned coverage,
Gemini + OpenAI adapters, tool auto-provisioning, waker, MCP server surface,
portal (3-paste onboarding + health panel + prompt snippet), MOCK mode,
Render deploy. Fast follows: PDFs, Anthropic adapter, `/v3/messages` transcript
persistence, adaptive polling, structured extraction (config-flip design only).

## Platform asks (nice-to-have, never dependencies)

1. `attachments` in the v3 message serializer (one line) → kills the PIT paste.
2. Native media feature ETA.
3. Native assistant↔MCP: connect our server as a first-class media toolset.

## Non-goals

Serving non-Assistable bots; public listing; credit pool/managed keys;
platform-repo changes; widget file-upload UI (platform's job).

## Testing

- Unit: media signature, envelope parsing, sniffing, dedupe, adapters (fixtures),
  injection payloads, crypto round-trip.
- Integration: MOCK mode — fake v3 + fake GHL + fake providers.
- E2E: volunteer subaccount + real phone per modality, failure paths (dead key,
  oversize, stale URL), kill switches, restart idempotency.

## Risks & open questions

| Risk | Status / mitigation |
|---|---|
| Envelope `meta_data` exact keys differ from expected | Spike `tool` command prints raw body; endpoint parses defensively |
| Ingest lag → waker delay for first message from new contact | Measured in spike; watcher retries |
| PIT conversation-search/message-fetch shape surprises | Spike `fetch`; fallback: ask volunteer for conversation export to adjust |
| v3 rate limits force slow polling | Spike measures; adaptive polling; per-tenant keys shard budget |
| Assistant ignores the tool (prompt adherence) | Prompt snippet + tool description tuned in pilot; waker instruction names the tool explicitly |
| Customer AI-key limits/dead keys | Live validation + health panel + graceful tool fallback |
| Sensitive media | In-memory only; no persistence; pilot consent language |
| Native fix ships | Kill switches + marker; MCP server graduates into native support |
