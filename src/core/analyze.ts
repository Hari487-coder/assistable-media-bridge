import type { GhlClient } from "../clients/ghl";
import { downloadMedia } from "../media/download";
import { sniff } from "../media/sniff";
import type { MediaProvider } from "../providers";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";

export interface AnalyzeDeps {
  ghl: Pick<GhlClient, "latestMediaMessages">;
  processed: ProcessedStore;
  events: EventStore;
  provider: MediaProvider;
  fetchImpl?: typeof fetch;
}

const LABELS = { audio: "🎤 Voice note transcript", image: "📷 Image", pdf: "📄 Document" } as const;
const MAX_ATTACHMENTS = 3;

export async function analyzeForContact(
  deps: AnalyzeDeps, tenant: Tenant, contactId: string
): Promise<{ text: string; processedIds: string[] }> {
  const messages = await deps.ghl.latestMediaMessages({
    locationId: tenant.locationId, contactId,
  });
  const fresh = messages.filter((m) => !deps.processed.has(tenant.id, m.id));
  if (fresh.length === 0) {
    return { text: "[no new attachments found]", processedIds: [] };
  }

  const sections: string[] = [];
  let count = 0;
  for (const msg of fresh) {
    for (const url of msg.attachments) {
      if (count >= MAX_ATTACHMENTS) { sections.push("[additional attachments were skipped]"); break; }
      count += 1;
      const dl = await downloadMedia(url, { fetchImpl: deps.fetchImpl });
      if ("error" in dl) { sections.push(`[attachment could not be read: ${dl.error}]`); continue; }
      const s = sniff(dl.bytes);
      if (s.kind === "unknown") { sections.push("[attachment could not be read: unsupported_type]"); continue; }
      if (s.kind === "audio" && !tenant.modalities.audio) { sections.push("[audio processing is disabled for this account]"); continue; }
      if (s.kind === "image" && !tenant.modalities.image) { sections.push("[image processing is disabled for this account]"); continue; }
      try {
        const text = await deps.provider.describe({ kind: s.kind, mime: s.mime, bytes: dl.bytes });
        sections.push(`${LABELS[s.kind]}: ${text}`);
      } catch (err) {
        sections.push(`[attachment could not be read: ${err instanceof Error ? err.message : "provider_error"}]`);
      }
    }
  }
  const processedIds = fresh.map((m) => m.id);
  for (const id of processedIds) deps.processed.add(tenant.id, id);
  deps.events.record(tenant.id, "tool_call", `attachments=${count} messages=${processedIds.length}`);
  return { text: sections.join("\n\n"), processedIds };
}
