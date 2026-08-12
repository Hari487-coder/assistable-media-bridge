# Outbound Media Implementation Plan

> **Execution:** Inline, single-threaded in this session (owner rule: no agent fan-outs).
> Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let an Assistable assistant send a preloaded image, video, voice note or document mid-conversation, chosen from its own asset library by conversation context.

**Architecture:** A second Custom Tool (`send_media`) on the existing bridge. The tool resolves an asset by name from a per-tenant library of registered URLs, enforces server-side send limits, resolves the conversation's channel, and posts to GHL `/conversations/messages` with an `attachments` array using the tenant's PIT. Metadata only — GHL fetches the bytes.

**Tech Stack:** Node 25, Express, `node:sqlite`, raw fetch (no SDKs), vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-outbound-media-design.md`

## Global Constraints

- Assets store **metadata only**; the bridge never hosts or proxies asset bytes.
- Guardrails are keyed on **contact**, never conversation.
- Limits: 1 send per asset per contact; 3 successful sends per contact per rolling 24h; 60s cooldown. Blocked attempts never consume budget.
- Library capped at **20 assets per tenant**.
- Asset URLs must be http/https and must not resolve to a private address (reuse `isPrivateAddress`).
- **v3 `createTool` accepts no parameter schema** (verified: `clients/v3.ts:112`) — asset names live in the tool description and are validated server-side, returning valid names on a miss.
- Every failure returns a steering string the model can act on; never a bare error token.
- All stores tenant-scoped. All new resolver/fetch injection points must be stubbable so unit tests never touch real DNS or network.

---

### Task 1: Asset store and validation

**Files:**
- Modify: `src/db.ts` (add `assets`, `media_sends` tables + idempotent migrations)
- Create: `src/store/assets.ts`
- Create: `src/core/asset-url.ts` (URL validation shared by store and portal)
- Test: `test/assets.test.ts`

**Interfaces produced:**
- `createAssetStore(db): AssetStore` with `list(tenantId)`, `get(tenantId, name)`, `add(tenantId, input)`, `remove(tenantId, name)`, `count(tenantId)`
- `Asset = { id, tenantId, name, description, kind, url, createdAt }`
- `AssetKind = "image" | "video" | "audio" | "document"`
- `normalizeAssetName(raw): string` — lowercase slug
- `validateAssetUrl(url, opts): Promise<{ ok: true; kind: AssetKind } | { ok: false; error: string }>`

- [x] Write failing tests: name slugging, uniqueness per tenant, 20-asset cap, kind from content-type, kind fallback from extension, private-address rejection, non-http scheme rejection, unreachable URL rejection.
- [x] Run tests, confirm they fail.
- [x] Implement schema, store, and validation.
- [x] Run tests, confirm they pass. Commit.

---

### Task 2: GHL send and channel resolution

**Files:**
- Modify: `src/clients/ghl.ts`
- Test: `test/ghl-send.test.ts`

**Interfaces produced:**
- `sendMessage({ contactId, type, message, attachments }): Promise<{ ok: true; id?: string } | { ok: false; error: string }>`
- `latestConversationChannel(locationId, contactId): Promise<string>` — GHL type, `"SMS"` when undeterminable

- [x] Write failing tests: POST body carries `type`/`contactId`/`message`/`attachments`; non-2xx surfaces status; channel resolved from most recent conversation; unknown/missing channel defaults to SMS; WhatsApp/IG/FB/Email map through.
- [x] Run tests, confirm they fail.
- [x] Implement both methods on the existing client factory.
- [x] Run tests, confirm they pass. Commit.

---

### Task 3: Send core and guardrails

**Files:**
- Create: `src/core/send.ts`
- Test: `test/send.test.ts`

**Interfaces produced:**
- `sendAssetForContact(deps, tenant, { contactId, asset, caption }): Promise<{ text: string }>`
- `describeAssetsForPrompt(assets): string` — the asset list block embedded in the tool description

- [x] Write failing tests: happy path calls GHL with resolved channel and caption; unknown asset returns valid names; same asset twice blocked; 4th send in 24h blocked; cooldown blocks a second send inside 60s; blocked attempt does not consume budget; GHL failure returns steering text and records an error event; empty library returns a clear note.
- [x] Run tests, confirm they fail.
- [x] Implement resolution, guardrails, send, event recording, steering strings.
- [x] Run tests, confirm they pass. Commit.

---

### Task 4: HTTP door and tool provisioning

**Files:**
- Modify: `src/http/tool.ts` (add `POST /send/:token`)
- Modify: `src/core/provision.ts` (`SEND_TOOL_NAME`, description builder, ensure/assign second tool)
- Modify: `src/clients/v3.ts` (generalize `updateToolUrl` → also patch description)
- Modify: `src/http/app.ts` (wire asset store through)
- Test: `test/send-endpoint.test.ts`

**Interfaces produced:**
- `buildSendToolDescription(assets): string`
- `ensureSendTool(v3, tenant, toolUrl, assets)`
- `updateTool(toolId, patch: { url?: string; description?: string })`

- [x] Write failing tests: envelope with `asset` + `caption` reaches the core and returns `{result}`; missing contact returns a steering string not a 500; unknown token 404s; description lists asset names and descriptions; description re-pushed on library change.
- [x] Run tests, confirm they fail.
- [x] Implement endpoint, provisioning, and v3 patch generalization.
- [x] Run tests, confirm they pass. Commit.

---

### Task 5: Portal assets UI

**Files:**
- Modify: `src/http/portal.ts`
- Test: `test/portal-assets.test.ts`

- [x] Write failing tests: add asset via form; validation error rendered inline; remove asset; cap enforced with a clear message; list renders kind badge; tool description re-pushed after mutation.
- [x] Run tests, confirm they fail.
- [x] Implement the Assets section following existing portal markup and styling.
- [x] Run tests, confirm they pass. Commit.

---

### Task 6: Mock mode, docs, and full verification

**Files:**
- Modify: `src/mock/fakes.ts`, `README.md`
- Test: `test/e2e-mock.test.ts`

- [x] Extend mock state with a fake GHL send capturing the attachments array.
- [x] Add an e2e mock assertion: register asset → tool call → GHL send carries the URL.
- [x] Update README with the send half and the prompt snippet.
- [x] Run `npx tsc --noEmit` and the full suite; both clean. Commit.

---

## Post-build gate (from spec R1)

Outbound WhatsApp attachment rendering is unverified. One real WhatsApp send must be proven before this is called done. Everything else ships regardless; WhatsApp templates are slice 2.
