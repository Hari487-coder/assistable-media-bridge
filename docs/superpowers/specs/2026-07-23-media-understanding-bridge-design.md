# Media Understanding Bridge — Design Spec

**Date:** 2026-07-23
**Status:** Approved pending spike gate (SPIKE-1)
**Owner:** Hari
**Project dir:** `Case Study/assistable-media-bridge`

## Problem

Assistable assistants cannot understand non-text messages. Verified in platform source:

- Media-only inbound messages (image/PDF/voice note, no caption) are silently dropped
  before the AI runs — `enrich.worker.ts:479` (`empty_inbound_body` filter) and
  `agent-run.ts:468` (null-content filter). The assistant is never invoked; the
  conversation "breaks" and requires human intervention.
- Attachment URLs ARE persisted (`ingest.worker.ts` `normalizeAttachments`) but no
  consumer reads them; mimeType is discarded.
- No vision, OCR, PDF, or STT capability exists anywhere in the assistant path.

The native fix is "in development" with no public ETA. This product is a standalone
bridge that closes the gap without any Assistable platform change.

## Constraints (hard, from owner)

1. Fully self-serve portal pattern (like the live-KB portal): customer creates an
   account and connects things themselves; nothing operated per-customer.
2. **Strict BYO AI key** (decided 2026-07-22): customer pastes their own
   Gemini/OpenAI/Anthropic key. No credit pool, no platform-held provider costs.
   Accepted consequence: key-minting is the funnel bottleneck → invest in a guided
   key-creation flow in the portal.
3. Setup = a few clicks; more reliable than any manual token/workflow configuration.
4. All media types: images (OCR/understanding), PDFs, voice notes/audio.
5. No Assistable platform changes required.
6. Media-only messages (no caption) are the #1 broken case and MUST work.

## Architecture (council-reviewed 2026-07-22, hybrid recommendation)

**Detect via GHL Marketplace app; process with the customer's key; inject via
Assistable's own v3 API. No fabricated GHL messages.**

```
Contact sends voice note/image/PDF on WhatsApp/SMS/FB/IG
        │
        ▼
GHL fires InboundMessage webhook ──► Bridge service (marketplace app subscription)
        │                                   │ (Assistable's own webhook fires in
        │                                   │  parallel; its pipeline persists the
        │                                   │  message row, then drops media-only
        │                                   │  from enrich — unchanged)
        │                                   ▼
        │                        has attachment? no → ignore (loop-safe)
        │                                   │ yes
        │                                   ▼
        │                        download from GHL CDN (allowlisted domains,
        │                        size caps, magic-byte sniff)
        │                                   ▼
        │                        route by type on the TENANT'S key:
        │                          audio → transcribe · image → vision/OCR
        │                          · PDF → extract (+vision fallback for scans)
        │                                   ▼
        │                        resolve Assistable conversation by
        │                        ghlConversationId (v3 API, retry w/ backoff —
        │                        Assistable's ingest batching may lag seconds)
        │                                   ▼
        │                        POST /v3/chat/completions
        │                          { assistant_id, conversation_id,
        │                            additional_instructions:
        │                              "<marker> The contact just sent a
        │                               voice note. Transcript: …" }
        │                                   ▼
        └────────────► executeAgentRun (verified in source, chat.ts:72):
                       full normal pipeline — reply-channel resolution,
                       human-takeover + sleep-window checks, AI-replying
                       state, billing, tracing — sends the reply to the
                       contact through the standard outbound path.
```

### Why v3 injection beats GHL inbound-injection (council blind-spot finding)

- Zero synthetic GHL events: no phantom "Customer Replied" automations, no SLA/drip
  side effects, no CRM history pollution, no per-message rebilling of fake messages.
- No dependency on the unvalidated `POST /conversations/messages/inbound` +
  marketplace-token question, and no marketplace-review policy risk from
  fabricating contact-attributed messages (the app only *reads* webhooks).
- Inherits Assistable's own safety rails for free (takeover, sleep windows).

### Fallback (flagged, not default)

GHL inbound-injection ("🎤 [Voice note]: …" posted as inbound message) is a
designed-but-NOT-built fallback: the pipeline keeps an injection-strategy seam so
it can be added behind a config flag, but it is only built if SPIKE-1 kills the
v3 seam.
If ever enabled it MUST ship with a caption-skip policy and explicit
automation-hazard warnings at onboarding. It is also the seam a future
non-Assistable-bot mode would use (explicit non-goal for now).

## Components

1. **GHL Marketplace app (unlisted)** — OAuth install (pick location, authorize),
   webhook subscription to InboundMessage. Token store + refresh handling.
2. **Webhook receiver** — per-tenant endpoint; verifies source; ACK-then-process
   async; dedup on GHL message ID (in-store TTL set).
3. **Media pipeline** — download (SSRF-guarded to GHL CDN domains, size caps:
   25 MB audio/PDF, 10 MB image), magic-byte type sniff (never trust extension),
   route to provider adapter. First 3 attachments per message, rest noted.
4. **Provider adapters** (interface `describe(media) → text`):
   - **Gemini** (recommended default: one key covers audio + vision + PDF, free tier)
   - **OpenAI** (vision + Whisper)
   - **Anthropic** (image/PDF only — portal marks audio unsupported on this choice)
5. **Injection client** — v3 API: conversation lookup by ghlConversationId with
   retry/backoff (5 tries / 60 s — ingest batching lag), then chat/completions with
   the transcript in `additional_instructions`, prefixed with a fixed marker string
   (sunset/idempotency identifier).
6. **Portal** (live-KB pattern) — signup → "Install GHL app" button (OAuth) →
   paste Assistable v3 API key (validated live) → paste AI provider key (validated
   with a real test call) → guided key-creation walkthrough (screenshots, per
   provider) → per-location toggles (modalities, enable/disable = kill switch) →
   health panel: last event received, last processed, last error, key status.
7. **Tenant store** — SQLite; per-location row; all tokens/keys AES-256-GCM
   encrypted at rest, master key in env; never logged.

## Key behaviors & policies

- **Scope (MVP):** media-only messages (empty body + attachments). Captioned media
  is explicitly OUT for MVP: Assistable already replies to the caption text, and a
  second completion would double-reply. Captioned-media enrichment is a documented
  follow-up (depends on persisting the transcript into history — see SPIKE-3).
- **Failure fallback:** provider error / unsupported type / oversize → inject a
  completion instructing the assistant to acknowledge an unreadable attachment
  (per-tenant toggle, default on). Failure must never silently reproduce the
  original drop bug.
- **Health over silence:** every processed/failed event is visible in the portal
  health panel. Onboarding validates both keys with live calls. Key-dead and
  rate-limited states are surfaced, not swallowed.
- **Privacy:** attachments processed in memory only; no attachment bytes or
  transcripts persisted by the bridge; transcripts exist only inside Assistable's
  normal conversation flow. No media content in logs.
- **Sunset:** fixed marker in every injected `additional_instructions`; per-location
  kill switch; global kill switch. When Assistable ships native media support,
  disable per location in one click. (Owner action: get the native feature's real
  ETA from the platform team — sizes this bridge's lifespan.)
- **Billing note (documented to customers):** media replies draw the customer's
  Assistable wallet like any AI reply (they were previously free because broken),
  plus their own provider costs on their key.

## Spike gate (build nothing else first)

- **SPIKE-1 (go/no-go, ~half day):** dev subaccount, real WhatsApp voice note →
  confirm webhook payload attachment URL is downloadable (which token, expiry) →
  `POST /v3/chat/completions` with `conversation_id` + fake transcript in
  `additional_instructions` → **assistant's reply arrives on the phone.**
  Success criterion is the end-to-end reply, not a 200.
- **SPIKE-2:** conversation lookup — resolve Assistable `conversation_id` from the
  webhook's ghlConversationId via v3 API; measure ingest lag for a brand-new
  contact's first-ever (media-only) message.
- **SPIKE-3:** `createMessage` write semantics — can the transcript be persisted
  into history (source USER) without triggering sends? Unlocks follow-up-turn
  context and the captioned-media follow-up. Not MVP-blocking.

## MVP cut

WhatsApp voice notes + images, media-only case, Gemini + OpenAI adapters,
unlisted marketplace app, portal with guided key flow, Render deploy.
Fast follows: PDFs, Anthropic adapter, SMS/FB/IG verification (config, not
architecture), SPIKE-3-gated history persistence.

## Non-goals (explicit)

- Structured extraction to CRM fields (design injection payload so it's a config
  flip later; do not build).
- Serving non-Assistable bots / public marketplace listing / ecosystem play
  (channel-conflict risk — needs a business decision, not an engineering one).
- Credit pool / managed keys (owner decided strict BYO).
- Modifying anything in the Assistable platform repos.

## Testing

- Unit: type sniffing, dedup, provider adapters against fixtures, injection
  payload construction, encryption round-trip.
- Integration: fake GHL webhook + mock providers + mock v3 API (MOCK mode like
  attribution-bridge).
- E2E: dev subaccount + real phone, per modality, including failure paths
  (dead key, oversize file, unknown type) and the kill switch.

## Risks & open questions

| Risk | Status / mitigation |
|---|---|
| Attachment URL auth/expiry unknown | SPIKE-1 |
| Ingest lag → conversation lookup race | Retry w/ backoff; measured in SPIKE-2 |
| `additional_instructions` one-shot (no history persistence) | Accepted for MVP; SPIKE-3 explores `createMessage` |
| GHL marketplace app review timeline | Unlisted app for pilot; review runs in parallel, never blocks |
| Customer AI-key rate limits mid-conversation | Health surfacing + failure-fallback completion |
| Sensitive media (IDs, bank screenshots) | In-memory only, no persistence, no content logs; pilot consent language |
| Native fix ships → double processing | Marker + kill switches; owner to obtain ETA |
