# Media MCP — Media Understanding for Assistable (Design Spec)

**Date:** 2026-07-23 (rev 2 — MCP-first architecture, replaces the GHL-marketplace-app hybrid)
**Status:** Approved pending spike gate (SPIKE-1)
**Owner:** Hari
**Project dir:** `Case Study/assistable-media-bridge`

## Problem

Assistable assistants cannot understand non-text messages. Verified in platform source:

- Media-only inbound messages (image/PDF/voice note, no caption) are silently dropped
  before the AI runs — `enrich.worker.ts:479` (`empty_inbound_body` filter) and
  `agent-run.ts:468` (null-content filter). The assistant is never invoked.
- The drop happens BEFORE the `message.received` outbound webhook emission
  (`enrich.worker.ts:1222`), so platform webhooks never fire for media-only
  messages either — and their payload carries no attachments regardless.
- Attachment URLs ARE persisted on the Message row (`ingest.worker.ts`
  `normalizeAttachments`) but no consumer reads them; no v3 read route exposes
  them (`MESSAGE_SELECT` omits `attachments`).
- GHL attachment URLs go stale (documented in `call-events.ts:2487` — 403/dead
  links); any design must fetch a fresh URL at processing time.

The native fix is "in development" with no public ETA.

## Constraints (hard, from owner)

1. Fully self-serve portal pattern (like the live-KB portal); nothing operated
   per-customer.
2. **Strict BYO AI key** (decided 2026-07-22). Guided key-creation flow in the
   portal is the mitigation for key-minting friction.
3. Setup = a few clicks / pastes; more reliable than manual workflow configuration.
4. All media types: images (OCR/understanding), PDFs, voice notes/audio.
5. No Assistable platform changes required.
6. Media-only messages (no caption) MUST work.
7. **MCP is the product's interface** (owner directive 2026-07-23): the service IS
   an MCP server; it must plug directly into Assistable's announced native MCP
   support the day that ships.

## The physics (why a watcher exists)

MCP is a pull protocol: servers are called, they do not observe. Nothing in MCP
can detect an inbound WhatsApp message — and the natural caller (the assistant)
is exactly what never wakes on media-only messages. Therefore the product is an
MCP server (permanent interface) plus a **detection watcher** (temporary shim
that MCP-the-protocol cannot provide). When native assistant↔MCP support ships,
the watcher retires per tenant; the MCP server graduates into the native feature.

## Architecture

```
Contact sends voice note/image/PDF (WhatsApp/SMS/FB/IG)
        │
        ▼
GHL webhook → Assistable ingest persists Message row
  (content=null, attachments[], conversation row created)   [unchanged platform]
  enrich drops it (empty_inbound_body) — assistant never wakes [the bug]
        │
        ▼
┌─ Media MCP service (one hosted app, Render) ─────────────────────────────┐
│                                                                          │
│  WATCHER (per tenant, ~20–30s cycle, tenant's v3 API key):               │
│    poll GET /v3/conversations?sort=newest → changed conversations        │
│    → list messages (v3) → inbound USER + empty content = media signature │
│    → fetch message via GHL API (tenant PIT) for FRESH attachment URL     │
│    → download (allowlisted domains, size caps, magic-byte sniff)         │
│    → route on tenant's BYO key:                                          │
│        audio → transcribe · image → vision/OCR · PDF → extract           │
│    → POST /v3/chat/completions { assistant_id, conversation_id,          │
│        additional_instructions: "<marker> transcript…" }                 │
│      → executeAgentRun (chat.ts:72): FULL normal pipeline — reply        │
│        channel, human-takeover + sleep-window checks, billing, tracing — │
│        sends the reply to the contact                                    │
│    → optional (SPIKE-3): POST /v3/messages (source API) to persist the   │
│      transcript into history for follow-up turns                         │
│                                                                          │
│  MCP SERVER (Streamable HTTP, same service):                             │
│    tools: transcribe_audio · analyze_image · read_document ·             │
│           analyze_attachment · connect_location · status                 │
│    callable TODAY from: Assistable workflow-builder MCP node (native     │
│    MCP client, verified in v2 source), Claude, Cursor, any MCP client    │
│    callable TOMORROW from: assistants natively, when the platform's      │
│    announced MCP feature ships → watcher retires per tenant              │
└──────────────────────────────────────────────────────────────────────────┘
```

### What was rejected and why (decision log)

- **GHL Marketplace app (rev 1)** — cut: marketplace review friction, OAuth infra,
  and the unvalidated inbound-injection question, all replaced by v3 polling
  detection. No GHL app, no GHL workflows, no webhooks.
- **GHL inbound-message injection** — cut (council, 2026-07-22): fabricated
  contact-attributed messages fire phantom "Customer Replied" automations,
  double-reply on captioned media, pollute CRM history, and carry marketplace
  policy risk. The v3 `additional_instructions` seam has none of these.
- **Assistable outbound webhook → workflow trigger** — dead: `message.received`
  is emitted after the empty-body drop; media-only messages never fire it.
- **Assistable Custom Tool** — dead: media-only messages never wake the AI;
  Direct-Request execution needs a platform DB flip.
- **Workflow-builder-only solution** — dead as primary: workflow triggers are
  WEBHOOK/MANUAL/SCHEDULE only (no message trigger). The workflow MCP node
  remains a supported *consumer* of our MCP server for custom automations.

## Onboarding (portal, live-KB pattern)

Three pastes, each validated with a live call before accept:

1. **Assistable v3 API key** (watcher + injection)
2. **AI provider key** — Gemini default (one key: audio+vision+PDF, free tier),
   OpenAI supported (vision + Whisper), Anthropic image/PDF-only (portal marks
   audio unsupported). Guided key-creation walkthrough per provider.
3. **GHL Private Integration Token** — read-only conversation scopes, exact
   checkbox checklist shown; used ONLY to fetch fresh media URLs/bytes.
   No workflow creation. (Drops to two pastes if the platform ever adds
   `attachments` to the v3 message serializer — a one-line `MESSAGE_SELECT`
   change worth requesting; see Platform asks.)

Per-location controls: modality toggles, enable/disable (kill switch), health
panel (last poll, last detection, last injection, last error, key status).

## Key behaviors & policies

- **Scope (MVP):** media-only messages (empty content + attachments). Captioned
  media stays OUT (Assistable already answers the caption; enrichment for
  captioned media is a follow-up gated on SPIKE-3 history persistence).
- **Latency budget:** poll interval + processing ≈ reply in under ~1 minute.
  Acceptable for async messaging (today's behavior is no reply, ever).
  Tighten later via adaptive polling (hot conversations polled faster).
- **Failure fallback (per-tenant toggle, default on):** provider error /
  unsupported type / oversize / stale URL → inject a completion instructing the
  assistant to acknowledge an unreadable attachment. Never silently reproduce
  the original drop bug.
- **Idempotency:** processed-message ID set (TTL) so restarts/re-polls never
  double-inject; the `additional_instructions` marker doubles as the audit tag.
- **Privacy:** attachments processed in memory only; no bytes or transcripts
  persisted by the service; no media content in logs; keys/PITs AES-256-GCM
  encrypted at rest (master key in env).
- **Billing note (documented):** media replies draw the customer's Assistable
  wallet like any AI reply + their own provider costs.
- **Rate-limit citizenship:** poll cadence tuned to v3RateLimit budget
  (measured in SPIKE-2); conversation-list poll is 1 req/cycle, message fetches
  only for changed conversations.

## Spike gate (build nothing else first)

- **SPIKE-1 (go/no-go, ~half day, all Assistable-side):** dev subaccount, real
  WhatsApp voice note →
  (a) v3 poll shows the conversation bump + empty-content inbound row (measure
  ingest lag); (b) GHL message fetch via PIT returns a downloadable attachment
  URL; (c) `POST /v3/chat/completions` with a fake transcript in
  `additional_instructions` → **assistant's reply arrives on the phone.**
  Success criterion = the reply, not a 200.
- **SPIKE-2:** polling cadence vs v3 rate limits; detection latency distribution.
- **SPIKE-3 (not MVP-blocking):** do `POST /v3/messages` (source API) rows enter
  the agent's LLM context on later runs? Unlocks follow-up-turn context and
  captioned-media enrichment.

## MVP cut

WhatsApp voice notes + images, media-only case, Gemini + OpenAI adapters,
portal with guided key flows + health panel, MCP server surface (media tools),
Render deploy. Fast follows: PDFs, Anthropic adapter, SMS/FB/IG verification,
SPIKE-3-gated history persistence, adaptive polling.

## Platform asks (nice-to-have, never dependencies)

1. `attachments` in the v3 message serializer (one line) → kills the PIT paste.
2. Native media feature ETA (sizes this product's lifespan).
3. When native assistant↔MCP ships: connect our server as a first-class media
   toolset (the graduation path).

## Non-goals

- Structured extraction to CRM fields (payload designed so it's a config flip
  later; not built).
- Serving non-Assistable bots; public ecosystem listing.
- Credit pool / managed keys (strict BYO stands).
- Any Assistable platform-repo changes.

## Testing

- Unit: media signature detection, type sniffing, dedup/idempotency, provider
  adapters against fixtures, injection payload, encryption round-trip.
- Integration: MOCK mode — fake v3 API + fake GHL + fake providers (pattern
  from attribution-bridge).
- E2E: dev subaccount + real phone per modality, failure paths (dead key,
  oversize, stale URL), kill switch, restart-idempotency.

## Risks & open questions

| Risk | Status / mitigation |
|---|---|
| Ingest lag → detection delay for first-ever message from new contact | Measured in SPIKE-1a; retries built into watcher |
| PIT message-fetch doesn't return usable attachment URLs | SPIKE-1b; fallback = marketplace app returns (rev 1 design) for the fetch role only |
| v3 rate limits force slow polling at scale | SPIKE-2; adaptive polling; per-tenant keys shard the budget naturally |
| `additional_instructions` one-shot (no history persistence) | Accepted for MVP; SPIKE-3 explores `/v3/messages` |
| Customer AI-key rate limits / dead keys | Live validation at onboarding + health panel + failure-fallback completion |
| Sensitive media (IDs, bank screenshots) | In-memory only, no persistence, no content logs; pilot consent language |
| Native fix ships → overlap | Marker + kill switches; MCP server graduates into native support; owner to obtain ETA |
