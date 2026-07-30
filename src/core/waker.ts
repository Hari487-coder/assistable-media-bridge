import type { V3Client } from "../clients/v3";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";
import { mapLimit } from "./concurrency";

export type WakerState = Map<string, string>;

export interface WakerDeps {
  v3: Pick<V3Client, "listConversations" | "listMessages" | "chatCompletion" | "assignTool">;
  processed: ProcessedStore;
  events: EventStore;
  state: WakerState;
  /** Wall-clock ceiling for one tenant's cycle. See CYCLE_BUDGET_MS. */
  budgetMs?: number;
}

// A tenant whose conversations all went quiet at once can have a long `pending`
// list, and each entry costs a listMessages round-trip. Left unbounded, that one
// tenant holds its concurrency slot for minutes while everybody else waits. The
// budget stops the loop early and — because the cursor only advances past
// conversations we actually finished — the remainder is picked up next cycle.
// Not a deadline on work, just on how much of it happens per turn.
export const CYCLE_BUDGET_MS = 20_000;

// Tenants polled at once. Sequential meant a pass grew linearly with tenant
// count until it silently outran the poll interval; unbounded would hammer the
// v3 rate limiter and trip its concurrency cap.
export const DEFAULT_WAKER_CONCURRENCY = 4;

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
  let handled = 0;
  const startedAt = Date.now();
  const budgetMs = deps.budgetMs ?? CYCLE_BUDGET_MS;
  for (const conv of pending) {
    // Checked only AFTER the first conversation: a budget too small for even one
    // round-trip must still make progress, or the cursor never moves and the
    // tenant livelocks.
    if (handled > 0 && Date.now() - startedAt > budgetMs) {
      deps.events.record(
        tenant.id, "poll_budget",
        `paused after ${handled}/${pending.length} conversations (${budgetMs}ms budget) — the rest resume next cycle`
      );
      break;
    }
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
      handled += 1;
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

export interface WakerRuntimeOptions {
  concurrency?: number;
  /** Called when one pass outruns the poll interval. Injectable for tests; the
   *  default writes to the service log, which is where an operator would look. */
  onOverrun?: (info: { durationMs: number; tenants: number; intervalMs: number }) => void;
}

const defaultOnOverrun = (i: { durationMs: number; tenants: number; intervalMs: number }) => {
  console.warn(
    `[media-mcp] waker pass took ${i.durationMs}ms across ${i.tenants} tenant(s), longer than the ` +
    `${i.intervalMs}ms poll interval — attachments are now detected more slowly than configured. ` +
    "Raise WAKER_CONCURRENCY, or WAKER_INTERVAL_MS to match reality."
  );
};

export function startWaker(
  cycleFor: (tenant: Tenant) => Promise<{ woken: number }>,
  listTenants: () => Tenant[],
  intervalMs: number,
  opts: WakerRuntimeOptions = {}
): { stop(): void } {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_WAKER_CONCURRENCY);
  const onOverrun = opts.onOverrun ?? defaultOnOverrun;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // no overlapping passes if a cycle runs long
    running = true;
    const startedAt = Date.now();
    let due: Tenant[] = [];
    try {
      due = listTenants().filter((t) => t.enabled && t.wakerEnabled);
      await mapLimit(due, concurrency, async (t) => {
        try {
          await cycleFor(t);
        } catch {
          // per-tenant isolation — one tenant's failure never stalls others
        }
      });
    } finally {
      running = false;
      // The reentrancy guard means an overrunning pass degrades SILENTLY: the
      // next tick is skipped and the effective interval stretches with nothing
      // to show for it. This is the only signal that it is happening.
      const durationMs = Date.now() - startedAt;
      if (due.length > 0 && durationMs > intervalMs) {
        try {
          onOverrun({ durationMs, tenants: due.length, intervalMs });
        } catch { /* reporting must never break the poll loop */ }
      }
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
