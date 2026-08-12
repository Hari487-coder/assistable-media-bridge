# Outbound Media — Assistants That Send (Design Spec)

**Date:** 2026-08-07
**Status:** Approved (owner: "yes write the spec")
**Owner:** Hari · **Origin:** customer feature request "Multimedia AI Assistants" (posted to Jorden Williams)
**Project dir:** `Case Study/assistable-media-bridge` — extends the existing bridge, not a new service

## Problem

The request: assistants should send images, videos, voice notes and documents — and preloaded
WhatsApp templates — choosing the right asset from conversation context, instead of replying with
text only.

They cannot do any of it today, and the reason is structural rather than configuration.
Source-verified in the platform:

- `sendMessage` — the only outbound path — posts exactly `{ type, contactId, message, html }` to
  `/conversations/messages` (`be/.../packages/api/src/services/ghl.ts:174`). There is no
  `attachments` field in the body.
- Ingestion deliberately empties attachments on AI-authored messages:
  `attachments: data.ai ? [] : (data.attachments ?? [])`
  (`v2/.../build-ship-unified-ingestion/lib/handlers/messages.ts:136`, and identically in
  `v2/.../api/buildship/messages/route.ts:173,180`).

So the column exists and carries inbound media, but anything the AI sends is forced to text-only by
construction. This is a missing capability, which is why the bridge pattern applies here exactly as
it did for reading media.

## What GHL supports (verified)

- `POST /conversations/messages` accepts `attachments`: an array of URL strings.
- `POST /conversations/messages/upload` returns hosted URLs, but caps at 5 files of 5 MB and
  **requires a `conversationId` or `contactId`** — so it cannot host a standing asset library.
- Valid `type` values: `SMS`, `Email`, `WhatsApp`, `IG`, `FB`, `Custom`, `Live_Chat`,
  `InternalComment` (`be/.../services/ghl.ts:28-37`).

## Decisions

**D1 — Extend the media bridge.** Reuses the tenant store, the per-tenant GHL PIT, Custom Tool
provisioning with assign-on-wake, the portal, the event feed, and the SSRF controls. A second
service would duplicate every one of those and add another instance to keep alive. The product
story is also stronger as one thing: your assistant can see *and* send media.

**D2 — Assets are registered URLs; we store metadata only.** The tenant uploads assets wherever
they already live (GHL's Media Library is the natural home) and registers each with a name and a
description. GHL fetches the bytes at send time.

- *Rejected:* bridge-hosted uploads — adds public file serving, storage, bandwidth and a new
  unauthenticated surface to a service that currently stores none of the customer's content.
- *Rejected:* GHL's upload endpoint — it needs a contact, so a standing library would require a
  dummy contact and would re-burn the 5-file limit per conversation.

**D3 — Bounded autonomy.** The model picks freely; the bridge enforces limits it cannot talk its
way past. Media repeated is far more irritating than text repeated, and the failure mode to design
out is a lead receiving the same demo video on every turn.

## Architecture

One new Custom Tool, provisioned and assigned by the existing machinery:

```
send_media(asset: string, caption?: string)
```

Flow: envelope → resolve tenant + `contactId` → look up asset by name → guardrails → resolve
channel → `POST /conversations/messages` with `attachments: [url]` via the tenant's PIT → record the
send → return a steering string to the model.

### The media is its own message, and it arrives first

Assistable's reply cannot carry attachments (see Problem), so ours must be a separate GHL message.
The tool fires *during* the agent run, so our message lands **before** the AI's text reply — the
reverse of the request's example ("Here's a quick video 👇" then the video).

The `caption` parameter resolves this: the lead-in line rides on the media message itself, and the
tool's return value tells the model which caption already went out so its own reply does not repeat
it. This mirrors the "already read" steering note tuned on the inbound side, which exists because a
bare status string got read as an error and produced a wrong reply.

### The asset list lives in the tool description

The model can only choose an asset it knows exists. Names and descriptions therefore go in the tool
description, which costs no extra latency and no second round trip — a `list_media` tool would add a
call before every send. When the library changes, the bridge PATCHes the tool description; the
provisioning code already PATCHes tool URLs.

*Build-time verification:* if v3 tool parameters accept a JSON-schema `enum`, the asset name becomes
impossible to hallucinate. If they do not, the server validates the name and returns the valid names
in the error string so the model can retry correctly. Either way the behaviour is defined.

The library is capped at **20 assets per tenant** to bound description size.

### Channel resolution is mandatory

GHL's send requires a `type`. Hardcoding `SMS` would push an SMS into a WhatsApp thread — wrong
channel, real cost, probable failure. The bridge resolves the contact's most recent conversation and
sends on that channel, defaulting to `SMS` when it cannot be determined. WhatsApp support falls out
of this rather than needing its own code path.

### Guardrails (server-enforced)

- each asset at most **once per contact**
- at most **3 media sends per contact per rolling 24 hours**, counting successful sends only, so a
  blocked attempt never consumes the budget
- **60-second cooldown** between sends to the same contact, so one turn cannot fire twice

Keyed on **contact, not conversation**: the inbound work established that a contact owns several
threads and that search rank flips which one appears first, so a per-conversation key would leak
duplicate sends. Every block returns a steering string ("you already sent this video earlier in this
conversation — refer back to it instead of resending") and records a `media_skip` event.

## Data model

Two tables alongside the existing ones:

- `assets` — `id`, `tenantId`, `name`, `description`, `kind`, `url`, `disabled`, `createdAt`;
  unique on `(tenantId, name)`
- `media_sends` — `id`, `tenantId`, `contactId`, `assetId`, `channel`, `sentAt`;
  indexed on `(tenantId, contactId)`

`kind` is one of `image | video | audio | document`, determined at registration from the response
content type, falling back to the URL file extension when the server sends none, and used only for
display and for the description shown to the model.

## Validation and security

- Asset URLs must be `http`/`https`, and are rejected if the host resolves to a private, loopback,
  link-local, CGNAT or IPv6-ULA address — reusing `isPrivateAddress` from `src/media/download.ts`
  (shipped 14c5c1e). A tenant must not be able to register an internal URL and have GHL fetch it.
- Registration performs a reachability check and records the content type; an unreachable URL is
  refused at registration rather than failing silently in front of a lead.
- Asset names are slugs, lowercase, unique per tenant.
- Captions are length-capped and sent as the message body, never interpolated into any URL.
- Every query is tenant-scoped, matching the existing store conventions.

## Portal

An **Assets** section in the existing portal: list, add, edit, remove, with inline validation errors,
a kind badge per asset, and confirmation that the assistant's tool was re-pushed after a change.
Follows the existing portal styling; no new design system.

## Observability

Reuses the event store so everything lands in the dashboard feed already in use:

- `media_send` — asset name, channel, contact
- `media_skip` — which guardrail blocked it
- `error` — GHL send failure with status

## Testing

- **Unit:** guardrail logic (once-per-asset, 24h cap, cooldown), asset resolution, unknown-asset
  error text, channel resolution including the SMS default, URL validation including private-address
  rejection, caption capping.
- **Integration:** tool endpoint receives an envelope and calls GHL with the correct body —
  `type`, `contactId`, `message`, `attachments`.
- **MOCK_MODE:** full loop with a fake GHL send asserting the attachments array, credential-free and
  offline, consistent with the existing mock e2e.

## Slice 1 scope

**In:** images, video, voice notes and documents; AI-chosen assets by description; all channels via
detection; the guardrails; portal CRUD; events.

**Out (deliberate):**

- **WhatsApp templates.** A genuinely different mechanism — Meta-approved template IDs and the
  24-hour messaging window — not a variation on sending a file. Slice 2.
- Bridge-hosted uploads, per-assistant asset gating, scheduled or drip media sequences.

## Risks

- **R1 — Outbound WhatsApp attachment rendering is unverified**, and WhatsApp is the request's
  headline use case. The known defect (GoHighLevel/highlevel-api-docs issue #50, closed without a
  documented resolution) is against `/conversations/messages/inbound`, not the send endpoint, so it
  is a warning rather than proof. **Gate: one real WhatsApp send must be proven before slice 1 is
  called done** — not after.
- **R2 — Tool description growth** with many assets; mitigated by the 20-asset cap.
- **R3 — Ordering:** media precedes the AI's text; mitigated by `caption`.
- **R4 — v3 tool parameter `enum` support unknown**; verified at build with a defined fallback.
- **R5 — Media costs money** on SMS/MMS and WhatsApp; the guardrails bound spend per contact and
  every send is recorded as an event.

## Acceptance criteria

1. A tenant can register a named asset with a description and see it listed in the portal.
2. An assistant sends that asset when the conversation calls for it, with the caption on the media
   message, and the contact receives it on the channel the conversation is actually using.
3. Re-asking for the same asset for the same contact does not resend it; the assistant refers
   back to it instead.
4. A fourth media send to the same contact within 24 hours is refused and recorded.
5. Registering a private-address URL is refused.
6. Sends, skips and failures are all visible in the dashboard activity feed.
7. One real WhatsApp send verified end to end (R1 gate).
