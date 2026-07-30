import type { V3Client } from "../clients/v3";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";

export type WakerState = Map<string, string>;

export interface WakerDeps {
  v3: Pick<V3Client, "listConversations" | "listMessages" | "chatCompletion" | "assignTool">;
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

// Provisioning attaches analyze_attachment to the ONE assistant chosen at
// onboarding, but wakes go to the conversation's pinned assistant — on a
// multi-assistant account that assistant has no tool to call and the wake
// instruction produces a generic guess-reply. Ensure the tool is attached to
// whichever assistant we are about to wake. Idempotent (m2m connect), cached
// via the processed store so it costs one API call per assistant, re-verified
// after each prune window. An assign failure never blocks the wake — the
// error event is the diagnostic.
async function ensureToolAssigned(
  deps: WakerDeps, tenant: Tenant, assistantId: string
): Promise<void> {
  if (!tenant.toolId) return;
  const key = `assigned:${assistantId}`;
  if (deps.processed.has(tenant.id, key)) return;
  try {
    const r = await deps.v3.assignTool(tenant.toolId, assistantId);
    if (r.ok) {
      deps.processed.add(tenant.id, key);
      deps.events.record(tenant.id, "assign", `tool=${tenant.toolId} assistant=${assistantId}`);
    } else {
      deps.events.record(tenant.id, "error", `assign failed assistant=${assistantId}: ${r.error}`);
    }
  } catch (err) {
    deps.events.record(
      tenant.id, "error",
      `assign failed assistant=${assistantId}: ${err instanceof Error ? err.message : "unknown"}`
    );
  }
}

export async function runWakerCycle(deps: WakerDeps, tenant: Tenant): Promise<{ woken: number }> {
  let conversations: Awaited<ReturnType<WakerDeps["v3"]["listConversations"]>>;
  try {
    conversations = await deps.v3.listConversations(WAKER_CONV_LIMIT);
  } catch (err) {
    // Without this, a dead poller (bad key, revoked subaccount, API outage)
    // shows as an eternally-empty activity feed — startWaker swallows the
    // rethrow, so this event is the only trace the tenant ever sees.
    deps.events.record(
      tenant.id, "error",
      `poll failed: ${err instanceof Error ? err.message : "unknown"}`
    );
    throw err;
  }
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
        await ensureToolAssigned(deps, tenant, assistantId);
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
