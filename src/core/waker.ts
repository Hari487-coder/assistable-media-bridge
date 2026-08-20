import type { GhlClient } from "../clients/ghl";
import type { MediaProvider } from "../providers";
import type { V3Client } from "../clients/v3";
import type { EventStore } from "../store/events";
import type { ProcessedStore } from "../store/processed";
import type { Tenant } from "../store/tenants";
import { analyzeForContact } from "./analyze";
import { mapLimit } from "./concurrency";

export type WakerState = Map<string, string>;

export interface WakerDeps {
  v3: Pick<V3Client, "listConversations" | "listMessages" | "chatCompletion" | "assignTool">;
  /** Consulted to resolve an ambiguous type, and to READ the media before
   *  waking — see the note on buildWakeInstruction. */
  ghl: Pick<GhlClient, "latestMediaMessages">;
  provider: MediaProvider;
  fetchImpl?: typeof fetch;
  lookupImpl?: Parameters<typeof analyzeForContact>[0]["lookupImpl"];
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

/** Inbound, from the contact, with no text — media-only OR a reaction. */
const isEmptyInbound = (m: { content: string | null; ai: boolean; source: string }) =>
  m.source === "USER" && m.ai === false && (!m.content || m.content.trim() === "");

// v3 MessageType values that carry something the tool can actually read.
const MEDIA_TYPES = new Set(["IMAGE", "AUDIO", "FILE", "VIDEO"]);

/**
 * Split a body-less inbound message into "there is media to read" vs "the
 * contact reacted".
 *
 * The assistant is never woken for a reaction. This exists so a reaction is not
 * MISTAKEN for an attachment: waking on one told the assistant something had
 * arrived to read, so it called analyze_attachment, got "[no new attachments
 * found]" and improvised — which is what a contact experiences as the AI
 * answering an emoji with nonsense. Recognising them means they are ignored
 * cleanly instead.
 *
 * When `type` is absent we assume media, since that is how every such message
 * was treated before this existed — an unknown type must never silently
 * downgrade a working voice-note wake into something we skip.
 *
 * "ambiguous" is a type we cannot read either way. It is NOT proof of a
 * reaction: MessageType has no REACTION member, and nothing in the platform
 * assigns IMAGE/AUDIO/FILE/VIDEO, so a real voice note can arrive carrying a
 * non-media type. Treating that as a reaction dropped a live customer's voice
 * note silently (account Dalmata, 2026-08-21). The caller resolves ambiguity by
 * asking the CRM whether attachments actually exist, which is the only
 * authoritative answer available.
 */
export function classifyEmptyInbound(m: { type?: string | null }): "media" | "ambiguous" {
  if (!m.type) return "media";
  return MEDIA_TYPES.has(m.type.toUpperCase()) ? "media" : "ambiguous";
}

/**
 * Does this contact actually have an inbound attachment right now?
 *
 * The waker sees v3 messages, which do not expose attachments, so a body-less
 * message is unreadable from that side alone. The CRM does expose them, and it
 * is the same source analyze_attachment reads, so its answer is the one that
 * matters. Fails OPEN: if the lookup breaks we wake anyway, because a missed
 * voice note is a silent customer-facing failure while an unnecessary wake just
 * makes the tool report it found nothing.
 */
async function hasFreshAttachments(
  deps: WakerDeps, tenant: Tenant, contactId: string | null
): Promise<boolean> {
  if (!contactId) return true;
  try {
    const msgs = await deps.ghl.latestMediaMessages({
      locationId: tenant.locationId, contactId, limit: 5,
    });
    return msgs.length > 0;
  } catch {
    return true;
  }
}

/**
 * What we tell the assistant when we wake it.
 *
 * Asking it to CALL analyze_attachment is unreliable, and not because of the
 * prompt. A media-only message has no content, so agent-run drops it from the
 * history entirely; the tail is then the assistant's own last message, and
 * ensureRespondableTail appends a synthetic user turn reading "Send your next
 * follow-up message to the contact now... Output ONLY the message text". That
 * is the FINAL user turn, it instructs the model not to use tools, and it beats
 * anything we put in the system prompt. Observed live (account Dalmata,
 * 2026-08-21): three voice notes, three correct wakes, zero tool calls, and an
 * assistant that just continued its qualification script.
 *
 * So we read the media ourselves and hand over the content. The model then has
 * nothing to decide — answering IS the follow-up message it was told to write.
 * Falls back to asking for the tool if reading fails, which is no worse than
 * the old behaviour.
 */
async function buildWakeInstruction(
  deps: WakerDeps, tenant: Tenant, contactId: string | null
): Promise<string> {
  if (!contactId) return WAKE_INSTRUCTION;
  try {
    const { text } = await analyzeForContact(
      {
        ghl: deps.ghl as Parameters<typeof analyzeForContact>[0]["ghl"],
        processed: deps.processed,
        events: deps.events,
        provider: deps.provider,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.lookupImpl ? { lookupImpl: deps.lookupImpl } : {}),
      },
      tenant, contactId
    );
    // Every failure path in analyzeForContact returns a bracketed note rather
    // than throwing. Handing the model "[attachment could not be read]" is
    // still better than asking for a tool call it will not make — it at least
    // knows not to pretend it heard something.
    if (!text.trim()) return WAKE_INSTRUCTION;
    deps.events.record(tenant.id, "tool_call", `pre-read for wake (contact ${contactId})`);
    return (
      "[media-mcp] The contact just sent an attachment. This is what it contains:\n\n" +
      `${text}\n\n` +
      "Reply to the contact about this now, in their language. Do not mention any tool " +
      "or technical process, do not say you cannot open attachments, and do not ask them " +
      "to repeat themselves."
    );
  } catch {
    return WAKE_INSTRUCTION;
  }
}

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
      const all = messages.filter(
        (m) => isEmptyInbound(m) && !deps.processed.has(tenant.id, `waker:${m.id}`)
      );
      // Reactions never wake the assistant. They are still marked processed, or
      // every cycle would re-detect the same thumbs-up forever. A burst mixing
      // both (a photo then a reaction) still wakes on the photo.
      const certain = all.filter((m) => classifyEmptyInbound(m) === "media");
      const ambiguous = all.filter((m) => classifyEmptyInbound(m) !== "media");

      // An unreadable type is not evidence of a reaction, so ask the CRM
      // whether this contact actually has an attachment waiting. Only reached
      // when something is ambiguous, so the extra call is rare.
      let fresh = certain;
      if (ambiguous.length > 0) {
        const types = [...new Set(ambiguous.map((m) => m.type ?? "none"))].join("/");
        if (await hasFreshAttachments(deps, tenant, conv.contactId)) {
          fresh = all;
          deps.events.record(
            tenant.id, "detect",
            `conv=${conv.id} ambiguous=${ambiguous.length} types=${types} → attachments found, treating as media`
          );
        } else {
          for (const m of ambiguous) deps.processed.add(tenant.id, `waker:${m.id}`);
          deps.events.record(
            tenant.id, "detect",
            `conv=${conv.id} reactions=${ambiguous.length} types=${types} (ignored, no attachments on contact)`
          );
        }
      }
      if (fresh.length > 0) {
        // Record the raw v3 `type` values too. Which type a real channel
        // reaction arrives as is not documented anywhere, and this split depends
        // on it, so a live one is readable straight off the dashboard rather
        // than needing a DB dig.
        const types = [...new Set(fresh.map((m) => m.type ?? "none"))].join("/");
        deps.events.record(
          tenant.id, "detect", `conv=${conv.id} mediaOnly=${fresh.length} types=${types}`
        );
        const assistantId = conv.assistant?.id ?? tenant.assistantId;
        await ensureToolAssigned(deps, tenant, assistantId);
        const instruction = await buildWakeInstruction(deps, tenant, conv.contactId);
        const r = await deps.v3.chatCompletion({
          assistantId, conversationId: conv.id, additionalInstructions: instruction,
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
  /** Called once a tenant's poll has failed authentication this many times in a
   *  row. Wired to pause that tenant so a dead key stops being retried. */
  onAuthFailures?: (info: { tenant: Tenant; consecutive: number; lastError: string }) => void;
  authFailureLimit?: number;
}

// Three misses is past any plausible blip and well short of noticing a
// revoked key by accident.
const DEFAULT_AUTH_FAILURE_LIMIT = 3;

/**
 * Does this poll failure mean "the key will never work again" rather than "try
 * later"? Only auth failures auto-pause a tenant: a 500 or a timeout is exactly
 * the case where retrying every 25s IS the correct behaviour, and pausing on it
 * would take a healthy subaccount offline until someone noticed.
 */
export function isAuthFailure(message: string): boolean {
  return /\b(401|403)\b/.test(message) || /unauthor|forbidden|invalid api key/i.test(message);
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
  const authLimit = Math.max(1, opts.authFailureLimit ?? DEFAULT_AUTH_FAILURE_LIMIT);
  // Consecutive auth failures per tenant. In-memory on purpose: the PAUSE it
  // triggers is persisted, so a restart cannot resume the storm, but the counter
  // itself should start clean.
  const authFails = new Map<string, number>();
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
          authFails.delete(t.id); // a good poll clears the streak
        } catch (err) {
          // per-tenant isolation — one tenant's failure never stalls others.
          // But a REVOKED key fails identically forever, and retrying it every
          // 25s hammers the customer's API and shows up in their logs as a
          // runaway process (observed live: a tester revoked their key and the
          // requests kept coming). Count auth failures and hand the tenant off
          // to be paused. Non-auth failures deliberately do not increment: a
          // transient outage SHOULD keep retrying.
          const lastError = err instanceof Error ? err.message : "unknown";
          if (!isAuthFailure(lastError)) return;
          const consecutive = (authFails.get(t.id) ?? 0) + 1;
          authFails.set(t.id, consecutive);
          if (consecutive < authLimit) return;
          authFails.delete(t.id);
          try {
            opts.onAuthFailures?.({ tenant: t, consecutive, lastError });
          } catch { /* pausing must never break the poll loop */ }
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
