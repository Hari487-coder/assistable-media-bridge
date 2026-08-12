import type { GhlClient } from "../clients/ghl";
import type { V3Client } from "../clients/v3";
import type { MediaProvider } from "../providers";
import type { Asset } from "../store/assets";
import type { Tenant, TenantInput, TenantStore } from "../store/tenants";
import { buildAssetCatalogue } from "./send";

export const TOOL_DESCRIPTION =
  "Read the contact's most recent attachment (voice note, image, video, or document) " +
  "and return its content as text. Call this whenever the contact sends or mentions " +
  "an attachment, photo, video, voice note, or document.";

const TOOL_NAME = "analyze_attachment";

export const SEND_TOOL_NAME = "send_media";

/**
 * The send tool's description, rebuilt whenever the library changes.
 *
 * v3 tools carry no parameter schema (createTool sends name/description/url
 * only), so this text is the ONLY place the model learns which assets exist.
 * That makes it load-bearing rather than documentation: an out-of-date
 * description is an assistant guessing at asset names.
 */
export function buildSendToolDescription(assets: Asset[]): string {
  return [
    "Send one of this account's preloaded media assets (image, video, voice note or document) " +
    "to the contact in the current conversation. Call this when a specific asset would answer " +
    "the contact better than text — for example a demo video when they ask how something works.",
    "",
    'Arguments: "asset" is the exact name from the list below. "caption" is optional text sent ' +
    "with the media; the contact sees it on the media message itself, so do not repeat that line " +
    "in your own reply.",
    "",
    buildAssetCatalogue(assets),
  ].join("\n");
}

export interface ProvisionDeps {
  tenants: TenantStore;
  publicBaseUrl: string;
  v3Factory: (
    v3Key: string,
    subAccountId?: string
  ) => Pick<
    V3Client,
    "validateKey" | "listAssistants" | "createTool" | "findToolByName" | "assignTool" | "updateToolUrl"
  >;
  ghlFactory: (pit: string) => Pick<GhlClient, "validatePit">;
  providerFactory: (name: TenantInput["provider"], key: string) => MediaProvider;
}

/**
 * Create-or-recover the analyze_attachment tool for a tenant, repoint it at
 * this instance, assign it to the tenant's assistant, and persist the toolId.
 * Callable at onboarding AND later from the dashboard's "Retry tool setup" —
 * a create failure must never be a dead end.
 *
 * Recovery matters because v3 createTool can fail while the tool nonetheless
 * exists or once existed: the route 409s only on LIVE duplicates, but the DB
 * unique constraint on (subaccount, name) also covers soft-deleted rows, so a
 * previously-deleted analyze_attachment makes create 500 forever. A tool found
 * by lookup may also belong to an older bridge instance — its URL is repointed
 * here before reuse.
 */
export async function ensureTool(
  v3: Pick<V3Client, "createTool" | "findToolByName" | "assignTool" | "updateToolUrl">,
  tenants: Pick<TenantStore, "setToolId">,
  publicBaseUrl: string,
  tenant: Pick<Tenant, "id" | "token" | "assistantId">
): Promise<{ toolId: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const toolUrl = `${publicBaseUrl}/tool/${tenant.token}`;
  let toolId: string | null = null;
  let reused = false;
  let createErr: string | null = null;
  try {
    const created = await v3.createTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      url: toolUrl,
    });
    toolId = created.id;
    if (!toolId && created.conflict) {
      toolId = await v3.findToolByName(TOOL_NAME);
      reused = toolId !== null;
    }
  } catch (err) {
    createErr = err instanceof Error ? err.message : "error";
    try {
      toolId = await v3.findToolByName(TOOL_NAME);
      reused = toolId !== null;
    } catch { /* lookup also failed — fall through to the warning */ }
  }

  if (!toolId) {
    warnings.push(
      `could not auto-create the ${TOOL_NAME} tool${createErr ? ` (${createErr})` : ""} — create it manually with URL ${toolUrl} and assign it to assistant ${tenant.assistantId}`
    );
    return { toolId: null, warnings };
  }

  if (reused) {
    const up = await v3.updateToolUrl(toolId, toolUrl);
    if (!up.ok) {
      warnings.push(
        `an existing ${TOOL_NAME} tool was found but could not be repointed at this instance (${up.error}) — its URL may target an older deployment; set it to ${toolUrl} manually`
      );
    }
  }

  tenants.setToolId(tenant.id, toolId);
  const assigned = await v3.assignTool(toolId, tenant.assistantId);
  if (!assigned.ok) {
    warnings.push(
      `the ${TOOL_NAME} tool exists but could NOT be attached to your assistant (${assigned.error}). Attach it manually to assistant ${tenant.assistantId}, or the assistant will not be able to read attachments`
    );
  }
  return { toolId, warnings };
}

/**
 * Create-or-recover the send_media tool and keep its description current.
 *
 * Deliberately separate from ensureTool rather than folded into it: the two
 * tools fail independently, and a send-tool problem must never stop an
 * account from READING attachments, which is the feature people already
 * depend on. Same recovery shape as ensureTool — a create failure falls back
 * to lookup, because the v3 unique constraint covers soft-deleted rows and a
 * previously-deleted tool makes create fail forever.
 *
 * Safe to call repeatedly: onboarding, "retry tool setup", and after every
 * library edit, since the description is the only place the model learns
 * which assets exist.
 */
export async function ensureSendTool(
  v3: Pick<V3Client, "createTool" | "findToolByName" | "assignTool" | "updateTool">,
  tenants: Pick<TenantStore, "setSendToolId">,
  publicBaseUrl: string,
  tenant: Pick<Tenant, "id" | "token" | "assistantId" | "sendToolId">,
  assets: Asset[]
): Promise<{ toolId: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const toolUrl = `${publicBaseUrl}/send/${tenant.token}`;
  const description = buildSendToolDescription(assets);

  let toolId = tenant.sendToolId;
  if (!toolId) {
    try {
      const created = await v3.createTool({ name: SEND_TOOL_NAME, description, url: toolUrl });
      toolId = created.id ?? (created.conflict ? await v3.findToolByName(SEND_TOOL_NAME) : null);
    } catch {
      try { toolId = await v3.findToolByName(SEND_TOOL_NAME); } catch { /* fall through */ }
    }
    if (!toolId) {
      warnings.push(
        `could not create the ${SEND_TOOL_NAME} tool — create it manually with URL ${toolUrl} and assign it to assistant ${tenant.assistantId}, or the assistant will not be able to send media`
      );
      return { toolId: null, warnings };
    }
    tenants.setSendToolId(tenant.id, toolId);
  }

  // Always repoint AND refresh: a tool recovered from an older instance has a
  // stale URL, and any tool at all has a stale asset list after an edit.
  const up = await v3.updateTool(toolId, { url: toolUrl, description });
  if (!up.ok) {
    warnings.push(
      `the ${SEND_TOOL_NAME} tool could not be updated (${up.error}) — the assistant may be working from an out-of-date asset list`
    );
  }
  const assigned = await v3.assignTool(toolId, tenant.assistantId);
  if (!assigned.ok) {
    warnings.push(
      `the ${SEND_TOOL_NAME} tool exists but could NOT be attached to assistant ${tenant.assistantId} (${assigned.error}) — attach it manually or the assistant cannot send media`
    );
  }
  return { toolId, warnings };
}

/** Assistable ids are cuids: "c" + ~24 lowercase alphanumerics. GHL location
 *  IDs are ~20 mixed-case characters, so requiring 21+ lowercase chars can
 *  never match a real location id — only a pasted-in-the-wrong-column cuid. */
const CUID_SHAPE = /^c[a-z0-9]{20,}$/;

/**
 * Translate a failed PIT probe into the exact upstream response plus the fix
 * for THAT failure. One generic sentence here sent a live tester re-minting
 * tokens when the actual problem was the location id — 401, 403 and 400 are
 * three different mistakes with three different fixes.
 */
function pitFailureMessage(
  check: { status?: number; detail?: string }, locationId: string
): string {
  const upstream = check.status
    ? `GHL answered HTTP ${check.status}${check.detail ? ` — "${check.detail}"` : ""}`
    : `GHL could not be reached (${check.detail ?? "network error"})`;
  if (check.status === 401) {
    return `the GHL Private Integration Token was rejected (${upstream}). The token itself is invalid — ` +
      "it was mistyped, truncated, rotated, or deleted. In the CRM go to Settings → Private Integrations " +
      "and copy the full token again";
  }
  if (check.status === 403) {
    return `the GHL Private Integration Token is valid but not allowed to read conversations for location ${locationId} (${upstream}). ` +
      "Either it is missing the \"View Conversations\" scope, or it was created in a DIFFERENT subaccount — " +
      "a Private Integration token only works inside the subaccount it was created in";
  }
  if (check.status === 400 || check.status === 404 || check.status === 422) {
    return `GHL does not recognise ${locationId} as a location this token can query (${upstream}). ` +
      "The GHL Location ID is probably wrong — copy it from the CRM under Settings → Business Profile";
  }
  if (!check.status) {
    return `could not validate the GHL Private Integration Token: ${upstream}. ` +
      "This is a connectivity problem, not necessarily a bad credential — re-submit in a minute";
  }
  return `GHL failed the Private Integration Token check (${upstream}). ` +
    "This looks temporary on GHL's side — re-submit in a minute";
}

export async function provisionTenant(deps: ProvisionDeps, input: TenantInput) {
  // Cheapest possible check, before a single network call. The Assistable
  // subaccount id and the GHL location id are two DIFFERENT fields on the same
  // record (SubAccount.id is a cuid; SubAccount.locationId is the CRM's id), so
  // they are never equal — identical values mean the location id was pasted
  // into both columns, which is the single most natural mistake here.
  //
  // Left to run it costs four API calls and then fails as "assistant is not
  // visible to this v3 API key", because a workspace key happily resolves the
  // bogus subaccount to an empty one with no assistants. That error sends
  // people hunting through API keys instead of fixing the paste.
  if (input.subAccountId && input.subAccountId === input.locationId) {
    throw new Error(
      "the Subaccount ID and the GHL location ID are the same value, but they are different identifiers. " +
      "The subaccount id is Assistable's own and comes from the dashboard URL (/portal/<subAccountId>/...); " +
      "the location id comes from the CRM"
    );
  }
  // Same family of paste mistake, swapped instead of duplicated: an Assistable
  // cuid in the location column. Left to run, the PIT probe asks GHL about a
  // location that does not exist and the failure blames the token — seen live,
  // it sent the operator re-minting tokens instead of swapping two values.
  if (CUID_SHAPE.test(input.locationId)) {
    throw new Error(
      `"${input.locationId}" looks like an Assistable subaccount id (a long lowercase id starting with "c"), not a GHL location ID. ` +
      (input.subAccountId && !CUID_SHAPE.test(input.subAccountId)
        ? `The Subaccount and Location values appear SWAPPED — the order is: subaccount id first, GHL location ID second. Swap the two and re-submit`
        : "The GHL Location ID is ~20 mixed-case characters, copied from the CRM under Settings → Business Profile")
    );
  }

  const v3 = deps.v3Factory(input.v3Key, input.subAccountId);

  // 1. Validate all three credentials live, before persisting anything.
  const v3Check = await v3.validateKey();
  if (!v3Check.ok) {
    throw new Error(
      `Assistable v3 API key failed validation${v3Check.detail ? ` — ${v3Check.detail}` : ""}`
    );
  }
  const pitCheck = await deps.ghlFactory(input.ghlPit).validatePit(input.locationId);
  if (!pitCheck.ok) {
    throw new Error(pitFailureMessage(pitCheck, input.locationId));
  }
  const providerCheck = await deps.providerFactory(input.provider, input.aiKey).validateKey();
  if (!providerCheck.ok) {
    throw new Error(
      `${input.provider} API key failed validation${providerCheck.detail ? ` — ${providerCheck.detail}` : ""}`
    );
  }

  // Coherence check — the three credentials can each be individually valid
  // while belonging to DIFFERENT subaccounts. Seen live: a workspace v3 key
  // with the Subaccount ID field left blank self-resolved to an empty
  // subaccount → every waker poll saw 0 conversations and tool provisioning
  // targeted the wrong tenant, with zero errors anywhere. The assistant is
  // the anchor: it must be visible to this key.
  let assistants: Array<{ id: string; name: string }>;
  try {
    assistants = await v3.listAssistants();
  } catch (err) {
    throw new Error(
      `could not list assistants with this v3 key${err instanceof Error ? ` — ${err.message}` : ""}`
    );
  }
  // Zero assistants is a different diagnosis from "the one you named is not
  // here", and conflating them sent a live tester hunting through API keys for
  // an hour. A workspace key resolves ANY subaccount id it is handed, so a CRM
  // location id in that field lands on an empty subaccount instead of erroring —
  // which is exactly what an empty list means here.
  if (assistants.length === 0) {
    throw new Error(
      input.subAccountId
        ? `no assistants are visible in subaccount ${input.subAccountId}. Check that this is Assistable's subaccount id, taken from the dashboard URL (/portal/<subAccountId>/...) — it is NOT the GHL location ID. If the id is right, the subaccount has no assistants yet`
        : "this v3 API key can see no assistants at all. If the key is workspace-wide, fill in the Subaccount ID field so it knows which subaccount to use"
    );
  }
  if (!assistants.some((a) => a.id === input.assistantId)) {
    // Listing what IS here turns a dead end into a self-service fix. Without it
    // the only next move is guessing, and the commonest cause is simply pairing
    // a row's assistant with the wrong subaccount when onboarding several at
    // once — the right id is usually one of the ones printed below.
    const visible = assistants.slice(0, 10)
      .map((a) => `${a.id} (${a.name})`).join(", ");
    const more = assistants.length > 10 ? `, and ${assistants.length - 10} more` : "";
    throw new Error(
      `assistant ${input.assistantId} is not in ${input.subAccountId ? `subaccount ${input.subAccountId}` : "the subaccount this key resolves to"}. ` +
      `Assistants that ARE available here: ${visible}${more}. ` +
      "Use one of those, or check the row is pointing at the right subaccount."
    );
  }

  // 2. Persist the tenant (secrets encrypted at rest). Keyed on the GHL
  //    location: re-onboarding a location that is already connected UPDATES it
  //    rather than adding a second row. Two rows for one location means two
  //    waker cursors — the contact gets two AI replies and every attachment is
  //    billed twice. Validation above has already passed, so a reconnect can
  //    never overwrite a working tenant with credentials that don't work.
  const { tenant, reconnected } = deps.tenants.createOrUpdateByLocation(input);

  // 3. Create-or-recover the tool and ASSIGN it to the assistant. Assignment
  //    is what makes the assistant able to call it; a created-but-unassigned
  //    tool does nothing, so an assign failure is a loud warning, not a quiet
  //    success.
  const { toolId, warnings } = await ensureTool(v3, deps.tenants, deps.publicBaseUrl, tenant);

  return { tenant, toolId, warnings, reconnected };
}

export const PROMPT_SNIPPET =
  "If the contact sends, or refers to, a photo, image, screenshot, video, document, " +
  "or voice note, ALWAYS call the analyze_attachment tool first to read it, then " +
  "respond based on its content. Never say you cannot open attachments.";
