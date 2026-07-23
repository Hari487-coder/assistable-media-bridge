import type { GhlClient } from "../clients/ghl";
import type { V3Client } from "../clients/v3";
import type { MediaProvider } from "../providers";
import type { Tenant, TenantInput, TenantStore } from "../store/tenants";

export const TOOL_DESCRIPTION =
  "Read the contact's most recent attachment (voice note, image, or document) and " +
  "return its content as text. Call this whenever the contact sends or mentions an " +
  "attachment, photo, voice note, or document.";

export interface ProvisionDeps {
  tenants: TenantStore;
  publicBaseUrl: string;
  v3Factory: (v3Key: string) => Pick<V3Client, "validateKey" | "listAssistants" | "createTool">;
  ghlFactory: (pit: string) => Pick<GhlClient, "validatePit">;
  providerFactory: (name: TenantInput["provider"], key: string) => MediaProvider;
}

export async function provisionTenant(deps: ProvisionDeps, input: TenantInput) {
  const v3 = deps.v3Factory(input.v3Key);
  if (!(await v3.validateKey())) throw new Error("Assistable v3 API key failed validation");
  if (!(await deps.ghlFactory(input.ghlPit).validatePit(input.locationId)))
    throw new Error("GHL Private Integration Token failed validation for this location");
  if (!(await deps.providerFactory(input.provider, input.aiKey).validateKey()))
    throw new Error(`${input.provider} API key failed validation`);

  const tenant: Tenant = deps.tenants.create(input);
  const warnings: string[] = [];
  let toolId: string | null = null;
  try {
    const created = await v3.createTool({
      name: "analyze_attachment",
      description: TOOL_DESCRIPTION,
      url: `${deps.publicBaseUrl}/tool/${tenant.token}`,
      httpMethod: "POST",
    });
    toolId = created.id;
    if (toolId) deps.tenants.setToolId(tenant.id, toolId);
    else warnings.push("tool created but no id returned — verify in the dashboard");
  } catch (err) {
    warnings.push(`could not auto-create the analyze_attachment tool (${err instanceof Error ? err.message : "error"}) — create it manually in the portal UI with URL ${deps.publicBaseUrl}/tool/${tenant.token}`);
  }
  return { tenant, toolId, warnings };
}

export const PROMPT_SNIPPET =
  "If the contact sends, or refers to, a photo, image, screenshot, document, or " +
  "voice note, ALWAYS call the analyze_attachment tool first to read it, then " +
  "respond based on its content. Never say you cannot open attachments.";
