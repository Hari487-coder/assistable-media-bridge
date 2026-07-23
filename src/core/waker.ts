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

// Top-N recency window. A busy tenant with more than this many conversations
// updated within one poll interval can lag on the overflow until they get
// fresh activity — documented reliability limit; adaptive polling is the
// fast-follow. Bumped from 25 to widen the window cheaply.
const WAKER_CONV_LIMIT = 50;

export const WAKE_INSTRUCTION =
  "[media-mcp] The contact just sent one or more attachments (an image, document, " +
  "or voice note) that you cannot see directly. Call the analyze_attachment tool " +
  "now to read them, then respond helpfully to the contact based on what the tool " +
  "returns. Do not mention any technical process or tools to the contact.";

const isMediaOnly = (m: { content: string | null; ai: boolean; source: string }) =>
  m.source === "USER" && m.ai === false && (!m.content || m.content.trim() === "");

export async function runWakerCycle(deps: WakerDeps, tenant: Tenant): Promise<{ woken: number }> {
  const conversations = await deps.v3.listConversations(WAKER_CONV_LIMIT);
  deps.events.record(tenant.id, "poll", `conversations=${conversations.length}`);
  if (conversations.length === 0) return { woken: 0 };

  const batchNewest = conversations.map((c) => c.updatedAt).sort().at(-1) ?? "";
  const cursor = deps.state.get(tenant.id);
  if (cursor === undefined) {
    // Prime only — never storm history on first sight of a tenant.
    deps.state.set(tenant.id, batchNewest);
    return { woken: 0 };
  }

  // Process strictly ascending by updatedAt so the cursor can only move past
  // conversations we actually finished. A hard failure stops advancement at
  // the last completed conversation → the failed one (and everything after)
  // retries next cycle instead of being silently skipped.
  const pending = conversations
    .filter((c) => c.updatedAt > cursor)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));

  let advanceTo = cursor;
  let woken = 0;
  for (const conv of pending) {
    try {
      const messages = await deps.v3.listMessages(conv.id);
      const fresh = messages.filter(
        (m) => isMediaOnly(m) && !deps.processed.has(tenant.id, `waker:${m.id}`)
      );
      if (fresh.length > 0) {
        deps.events.record(tenant.id, "detect", `conv=${conv.id} mediaOnly=${fresh.length}`);
        const assistantId = conv.assistant?.id ?? tenant.assistantId;
        const r = await deps.v3.chatCompletion({
          assistantId, conversationId: conv.id, additionalInstructions: WAKE_INSTRUCTION,
        });
        // Mark AFTER the attempt (not before): mark-before permanently loses
        // the wake if chatCompletion throws. On ok:false we still mark to
        // avoid retry-storming an assistant-side failure.
        for (const m of fresh) deps.processed.add(tenant.id, `waker:${m.id}`);
        if (r.ok) {
          woken += 1;
          deps.events.record(tenant.id, "wake", `conv=${conv.id}`);
        } else {
          deps.events.record(tenant.id, "error", `wake failed conv=${conv.id}: ${r.error}`);
        }
      }
      // Conversation fully handled → safe to advance the cursor past it.
      advanceTo = conv.updatedAt > advanceTo ? conv.updatedAt : advanceTo;
    } catch (err) {
      // Hard throw: record and STOP advancing. Nothing marked, cursor stays →
      // this conversation and all later ones retry next cycle.
      deps.events.record(
        tenant.id, "error",
        `cycle conv=${conv.id}: ${err instanceof Error ? err.message : "unknown"}`
      );
      break;
    }
  }
  deps.state.set(tenant.id, advanceTo);
  return { woken };
}

export function startWaker(
  cycleFor: (tenant: Tenant) => Promise<{ woken: number }>,
  listTenants: () => Tenant[],
  intervalMs: number
): { stop(): void } {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // no overlapping passes if a cycle runs long
    running = true;
    try {
      for (const t of listTenants()) {
        if (!t.enabled || !t.wakerEnabled) continue;
        try {
          await cycleFor(t);
        } catch {
          // per-tenant isolation — one tenant's failure never stalls others
        }
      }
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
