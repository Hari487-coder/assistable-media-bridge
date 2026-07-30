import type { GhlClient } from "../clients/ghl";
import type { V3Client } from "../clients/v3";
import type { MediaProvider } from "../providers";
import type { Tenant, TenantInput, TenantStore } from "../store/tenants";

export const TOOL_DESCRIPTION =
  "Read the contact's most recent attachment (voice note, image, or document) and " +
  "return its content as text. Call this whenever the contact sends or mentions an " +
  "attachment, photo, voice note, or document.";

const TOOL_NAME = "analyze_attachment";

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

export async function provisionTenant(deps: ProvisionDeps, input: TenantInput) {
  const v3 = deps.v3Factory(input.v3Key, input.subAccountId);

  // 1. Validate all three credentials live, before persisting anything.
  const v3Check = await v3.validateKey();
  if (!v3Check.ok) {
    throw new Error(
      `Assistable v3 API key failed validation${v3Check.detail ? ` — ${v3Check.detail}` : ""}`
    );
  }
  if (!(await deps.ghlFactory(input.ghlPit).validatePit(input.locationId))) {
    throw new Error("GHL Private Integration Token failed validation for this location");
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
  if (!assistants.some((a) => a.id === input.assistantId)) {
    throw new Error(
      `assistant ${input.assistantId} is not visible to this v3 API key — the key resolves to a different subaccount. Mint the API key inside the SAME subaccount as the assistant (Dashboard → Integrations → API Key), or if you use a workspace-wide key, fill in the Subaccount ID field.`
    );
  }

  // 2. Persist the tenant (secrets encrypted at rest).
  const tenant: Tenant = deps.tenants.create(input);

  // 3. Create-or-recover the tool and ASSIGN it to the assistant. Assignment
  //    is what makes the assistant able to call it; a created-but-unassigned
  //    tool does nothing, so an assign failure is a loud warning, not a quiet
  //    success.
  const { toolId, warnings } = await ensureTool(v3, deps.tenants, deps.publicBaseUrl, tenant);

  return { tenant, toolId, warnings };
}

export const PROMPT_SNIPPET =
  "If the contact sends, or refers to, a photo, image, screenshot, document, or " +
  "voice note, ALWAYS call the analyze_attachment tool first to read it, then " +
  "respond based on its content. Never say you cannot open attachments.";
