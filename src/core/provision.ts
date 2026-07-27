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
    "validateKey" | "listAssistants" | "createTool" | "findToolByName" | "assignTool"
  >;
  ghlFactory: (pit: string) => Pick<GhlClient, "validatePit">;
  providerFactory: (name: TenantInput["provider"], key: string) => MediaProvider;
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

  // 2. Persist the tenant (secrets encrypted at rest).
  const tenant: Tenant = deps.tenants.create(input);
  const warnings: string[] = [];
  const toolUrl = `${deps.publicBaseUrl}/tool/${tenant.token}`;

  // 3. Create the tool (idempotent — reuse an existing one on 409), then ASSIGN
  //    it to the assistant. Assignment is what makes the assistant able to call
  //    it; a created-but-unassigned tool does nothing, so an assign failure is a
  //    loud warning, not a quiet success.
  let toolId: string | null = null;
  try {
    const created = await v3.createTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      url: toolUrl,
    });
    toolId = created.id;
    if (!toolId && created.conflict) {
      toolId = await v3.findToolByName(TOOL_NAME);
    }

    if (!toolId) {
      warnings.push(
        `could not resolve the ${TOOL_NAME} tool id — create it manually with URL ${toolUrl} and assign it to assistant ${input.assistantId}`
      );
    } else {
      deps.tenants.setToolId(tenant.id, toolId);
      const assigned = await v3.assignTool(toolId, input.assistantId);
      if (!assigned.ok) {
        warnings.push(
          `the ${TOOL_NAME} tool exists but could NOT be attached to your assistant (${assigned.error}). Attach it manually to assistant ${input.assistantId}, or the assistant will not be able to read attachments`
        );
      }
    }
  } catch (err) {
    warnings.push(
      `could not auto-create the ${TOOL_NAME} tool (${err instanceof Error ? err.message : "error"}) — create it manually with URL ${toolUrl} and assign it to assistant ${input.assistantId}`
    );
  }

  return { tenant, toolId, warnings };
}

export const PROMPT_SNIPPET =
  "If the contact sends, or refers to, a photo, image, screenshot, document, or " +
  "voice note, ALWAYS call the analyze_attachment tool first to read it, then " +
  "respond based on its content. Never say you cannot open attachments.";
