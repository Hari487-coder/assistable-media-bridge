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
  let skipped = 0;
  for (const msg of fresh) {
    for (const url of msg.attachments) {
      if (count >= MAX_ATTACHMENTS) {
        skipped += 1;
        continue;
      }
      // Failed/disabled attempts still consume a cap slot — the cap bounds
      // attempted work and cost, not successes.
      count += 1;
      try {
        const dl = await downloadMedia(url, { fetchImpl: deps.fetchImpl });
        if ("error" in dl) {
          sections.push(`[attachment could not be read: ${dl.error}]`);
          continue;
        }
        const s = sniff(dl.bytes);
        if (s.kind === "unknown") {
          sections.push("[attachment could not be read: unsupported_type]");
          continue;
        }
        if (s.kind === "audio" && !tenant.modalities.audio) {
          sections.push("[audio processing is disabled for this account]");
          continue;
        }
        if (s.kind === "image" && !tenant.modalities.image) {
          sections.push("[image processing is disabled for this account]");
          continue;
        }
        const text = await deps.provider.describe({ kind: s.kind, mime: s.mime, bytes: dl.bytes });
        sections.push(`${LABELS[s.kind]}: ${text}`);
      } catch (err) {
        // Blanket guard: NOTHING inside the per-attachment body may throw out
        // of analyzeForContact — every failure degrades to a bracketed note.
        sections.push(`[attachment could not be read: ${err instanceof Error ? err.message : "processing_error"}]`);
      }
    }
  }
  if (skipped > 0) {
    // Deliberate drop, not a deferral: capped-out attachments are never
    // retried (their message ids are marked processed below) — re-surfacing
    // stale media in a later run would confuse the conversation. The single
    // count note keeps the assistant honest about what it didn't see.
    sections.push(`[${skipped} additional attachment(s) were not processed]`);
  }
  if (sections.length === 0) {
    return { text: "[no new attachments found]", processedIds: [] };
  }
  const processedIds = fresh.map((m) => m.id);
  for (const id of processedIds) deps.processed.add(tenant.id, id);
  deps.events.record(tenant.id, "tool_call", `attachments=${count} messages=${processedIds.length}`);
  return { text: sections.join("\n\n"), processedIds };
}
