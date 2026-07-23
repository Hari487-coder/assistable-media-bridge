import type { V3Client } from "../clients/v3";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";

export type WakerState = Map<string, string>;

export interface WakerDeps {
  v3: Pick<V3Client, "listConversations" | "listMessages" | "chatCompletion">;
  processed: ProcessedStore;
  events: EventStore;
  state: WakerState;
}

export const WAKE_INSTRUCTION =
  "[media-mcp] The contact just sent one or more attachments (an image, document, " +
  "or voice note) that you cannot see directly. Call the analyze_attachment tool " +
  "now to read them, then respond helpfully to the contact based on what the tool " +
  "returns. Do not mention any technical process or tools to the contact.";

const isMediaOnly = (m: { content: string | null; ai: boolean; source: string }) =>
  m.source === "USER" && m.ai === false && (!m.content || m.content.trim() === "");

export async function runWakerCycle(deps: WakerDeps, tenant: Tenant): Promise<{ woken: number }> {
  const conversations = await deps.v3.listConversations(25);
  deps.events.record(tenant.id, "poll", `conversations=${conversations.length}`);
  if (conversations.length === 0) return { woken: 0 };

  const newest = conversations
    .map((c) => c.updatedAt).sort().at(-1) ?? "";
  const cursor = deps.state.get(tenant.id);
  deps.state.set(tenant.id, newest > (cursor ?? "") ? newest : (cursor ?? newest));
  if (cursor === undefined) return { woken: 0 }; // prime only — never storm history

  let woken = 0;
  for (const conv of conversations) {
    if (conv.updatedAt <= cursor) continue;
    const messages = await deps.v3.listMessages(conv.id);
    const fresh = messages.filter(
      (m) => isMediaOnly(m) && !deps.processed.has(tenant.id, `waker:${m.id}`)
    );
    if (fresh.length === 0) continue;
    for (const m of fresh) deps.processed.add(tenant.id, `waker:${m.id}`);
    deps.events.record(tenant.id, "detect", `conv=${conv.id} mediaOnly=${fresh.length}`);
    const assistantId = conv.assistant?.id ?? tenant.assistantId;
    const r = await deps.v3.chatCompletion({
      assistantId, conversationId: conv.id, additionalInstructions: WAKE_INSTRUCTION,
    });
    if (r.ok) { woken += 1; deps.events.record(tenant.id, "wake", `conv=${conv.id}`); }
    else deps.events.record(tenant.id, "error", `wake failed conv=${conv.id}: ${r.error}`);
  }
  return { woken };
}

export function startWaker(
  cycleFor: (tenant: Tenant) => Promise<{ woken: number }>,
  listTenants: () => Tenant[],
  intervalMs: number
): { stop(): void } {
  const timer = setInterval(async () => {
    for (const t of listTenants()) {
      if (!t.enabled || !t.wakerEnabled) continue;
      try { await cycleFor(t); } catch { /* cycle errors recorded downstream */ }
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
