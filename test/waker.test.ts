import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import {
  WAKE_INSTRUCTION, classifyEmptyInbound, isAuthFailure,
  runWakerCycle, startWaker,
} from "../src/core/waker";
import type { Tenant } from "../src/store/tenants";

const tenant = {
  id: "t1", token: "tok", label: "T", locationId: "L", assistantId: "A_default",
  provider: "gemini", v3Key: "v", ghlPit: "p", aiKey: "k",
  wakerEnabled: true, toolId: null, enabled: true,
  modalities: { audio: true, image: true },
} as Tenant;

const msg = (id: string, over: Partial<{ content: string | null; ai: boolean; source: string }> = {}) => ({
  id, content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t", ...over,
});

function make(
  convUpdatedAt: string,
  messages: ReturnType<typeof msg>[],
  opts: { assignOk?: boolean; contactHasAttachments?: boolean } = {}
) {
  const db = openDb(":memory:");
  const wakes: Array<{ assistantId: string; conversationId: string; additionalInstructions: string }> = [];
  const assigns: Array<{ toolId: string; assistantId: string }> = [];
  const deps = {
    v3: {
      listConversations: async () => [
        { id: "c1", contactId: "ct1", updatedAt: convUpdatedAt, assistant: { id: "A_conv" } },
      ],
      listMessages: async () => messages,
      chatCompletion: async (a: typeof wakes[number]) => { wakes.push(a); return { ok: true as const }; },
      assignTool: async (toolId: string, assistantId: string) => {
        assigns.push({ toolId, assistantId });
        return opts.assignOk === false
          ? { ok: false as const, error: "v3 assignTool HTTP 404" }
          : { ok: true as const };
      },
    },
    // The CRM is the authority on whether an attachment exists; the waker only
    // consults it when a message type is unreadable.
    provider: {
      describe: async () => "hola, quiero saber si tienen departamentos en Ñuñoa",
      validateKey: async () => ({ ok: true as const }),
    },
    fetchImpl: (async () => new Response(new TextEncoder().encode("OggS....."))) as unknown as typeof fetch,
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    ghl: {
      latestMediaMessages: async () =>
        (opts.contactHasAttachments
          ? [{ id: "g1", convId: "c1", attachments: ["https://storage.msgsndr.com/a.ogg"], direction: "inbound", dateAdded: "t" }]
          : []),
    },
    processed: createProcessedStore(db),
    events: createEventStore(db),
    state: new Map<string, string>(),
  };
  return { deps, wakes, assigns };
}

/** Wall-clock sleeps assume the event loop delivers N ticks in M ms, which it
 *  does not under parallel test load — these assertions failed at exactly the
 *  boundary. Wait for the condition instead. */
async function until(cond: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 5));
  }
}

describe("runWakerCycle", () => {
  it("first run primes the cursor and wakes nothing", async () => {
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [msg("m1")]);
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(deps.state.get("t1")).toBe("2026-07-23T10:00:00Z");
  });
  it("wakes once per conversation with new media-only messages", async () => {
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [msg("m1"), msg("m2")]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(1);
    expect(wakes[0].assistantId).toBe("A_conv"); // conversation assistant wins
    expect(wakes[0].additionalInstructions).toMatch(/^\[media-mcp\]/);
    expect(wakes[0].additionalInstructions).toContain("analyze_attachment");
  });
  it("assigns the tool to the conversation assistant before waking, once", async () => {
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const msgs = [msg("m1")];
    const { deps, wakes, assigns } = make("2026-07-23T10:00:00Z", msgs);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, withTool);
    expect(assigns).toEqual([{ toolId: "tool-1", assistantId: "A_conv" }]);
    expect(wakes).toHaveLength(1);
    expect(deps.events.latest("t1", 10).some((e) => e.kind === "assign")).toBe(true);

    // A later wake for the same assistant must not re-assign (cached).
    msgs.push(msg("m2"));
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, withTool);
    expect(wakes).toHaveLength(2);
    expect(assigns).toHaveLength(1);
  });

  it("an assign failure records an error but the wake still fires", async () => {
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const { deps, wakes, assigns } = make("2026-07-23T10:00:00Z", [msg("m1")], { assignOk: false });
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    const r = await runWakerCycle(deps as never, withTool);
    expect(assigns).toHaveLength(1);
    expect(r.woken).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(deps.events.latest("t1", 10).some(
      (e) => e.kind === "error" && e.detail.includes("assign failed")
    )).toBe(true);
  });

  it("skips assignment entirely when the tenant has no toolId", async () => {
    const { deps, wakes, assigns } = make("2026-07-23T10:00:00Z", [msg("m1")]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, tenant); // toolId: null
    expect(assigns).toHaveLength(0);
    expect(wakes).toHaveLength(1);
  });

  it("ignores non-matching messages and already-woken ids", async () => {
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [
      msg("m1", { content: "hello" }),          // has text
      msg("m2", { source: "ASSISTANT" }),        // outbound
      msg("m3", { ai: true }),                   // AI message
      msg("m4"),                                  // media-only — but seen below
    ]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    deps.processed.add("t1", "waker:m4");
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(0);
    expect(wakes).toHaveLength(0);
  });

  it("a hard failure mid-batch does not advance the cursor past unprocessed conversations", async () => {
    const db = openDb(":memory:");
    let call = 0;
    const wakes: string[] = [];
    const deps = {
      v3: {
        listConversations: async () => [
          { id: "cOld", contactId: "x", updatedAt: "2026-07-23T10:00:00Z", assistant: { id: "A" } },
          { id: "cNew", contactId: "y", updatedAt: "2026-07-23T11:00:00Z", assistant: { id: "A" } },
        ],
        listMessages: async (id: string) => {
          call += 1;
          if (id === "cOld") throw new Error("transient 503");
          return [msg("mN")];
        },
        chatCompletion: async (a: { conversationId: string }) => { wakes.push(a.conversationId); return { ok: true as const }; },
      },
      processed: createProcessedStore(db),
      events: createEventStore(db),
      state: new Map<string, string>([["t1", "2026-07-23T09:00:00Z"]]),
    };
    const r = await runWakerCycle(deps as never, tenant);
    expect(r.woken).toBe(0);                        // stopped at the failing cOld, never reached cNew
    expect(wakes).toHaveLength(0);
    expect(deps.state.get("t1")).toBe("2026-07-23T09:00:00Z"); // cursor did NOT advance
    expect(deps.events.latest("t1", 10).some((e) => e.kind === "error")).toBe(true);
  });

  it("a failing poll records an error event before rethrowing (no silent dead poller)", async () => {
    const db = openDb(":memory:");
    const deps = {
      v3: {
        listConversations: async () => { throw new Error("v3 listConversations HTTP 401"); },
        listMessages: async () => [],
        chatCompletion: async () => ({ ok: true as const }),
        assignTool: async () => ({ ok: true as const }),
      },
      processed: createProcessedStore(db),
      events: createEventStore(db),
      state: new Map<string, string>(),
    };
    await expect(runWakerCycle(deps as never, tenant)).rejects.toThrow(/401/);
    expect(deps.events.latest("t1", 5).some(
      (e) => e.kind === "error" && e.detail.includes("poll failed")
    )).toBe(true);
  });

  it("startWaker only cycles enabled tenants with wakerEnabled, and never overlaps", async () => {
    const seen: string[] = [];
    const tenants = [
      { ...tenant, id: "on" },
      { ...tenant, id: "disabled", enabled: false },
      { ...tenant, id: "wakeroff", wakerEnabled: false },
    ] as Tenant[];
    let inFlight = 0;
    let maxInFlight = 0;
    const cycleFor = async (t: Tenant) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(t.id);
      await new Promise((res) => setTimeout(res, 5));
      inFlight -= 1;
      return { woken: 0 };
    };
    const handle = startWaker(cycleFor, () => tenants, 1, { concurrency: 1 });
    await new Promise((res) => setTimeout(res, 40));
    handle.stop();
    expect(seen).toContain("on");
    expect(seen).not.toContain("disabled");
    expect(seen).not.toContain("wakeroff");
    expect(maxInFlight).toBe(1); // reentrancy guard held
  });

  it("polls tenants concurrently, up to the configured limit", async () => {
    // Serially, 8 tenants x 20ms is 160ms and grows linearly with the tenant
    // count until it silently outruns the poll interval.
    const tenants = Array.from({ length: 8 }, (_, i) => ({ ...tenant, id: `t${i}` })) as Tenant[];
    let inFlight = 0;
    let maxInFlight = 0;
    const done: string[] = [];
    const cycleFor = async (t: Tenant) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 20));
      inFlight -= 1; done.push(t.id);
      return { woken: 0 };
    };
    // Serve the list once so exactly one pass runs and the assertions are exact.
    let served = false;
    const listOnce = () => { if (served) return []; served = true; return tenants; };

    const handle = startWaker(cycleFor, listOnce, 5, { concurrency: 4 });
    await new Promise((res) => setTimeout(res, 120));
    handle.stop();
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(done).toHaveLength(8); // every tenant still polled
  });

  it("reports a pass that outruns the poll interval instead of degrading silently", async () => {
    const overruns: Array<{ durationMs: number; tenants: number }> = [];
    const handle = startWaker(
      async () => { await new Promise((res) => setTimeout(res, 30)); return { woken: 0 }; },
      () => [tenant],
      5,
      { onOverrun: (i) => overruns.push(i) }
    );
    await new Promise((res) => setTimeout(res, 70));
    handle.stop();
    expect(overruns.length).toBeGreaterThan(0);
    expect(overruns[0].tenants).toBe(1);
    expect(overruns[0].durationMs).toBeGreaterThanOrEqual(30);
  });

  it("does not report an overrun when there is nothing to poll", async () => {
    const overruns: unknown[] = [];
    const handle = startWaker(
      async () => ({ woken: 0 }),
      () => [{ ...tenant, wakerEnabled: false } as Tenant],
      1,
      { onOverrun: () => overruns.push(1) }
    );
    await new Promise((res) => setTimeout(res, 30));
    handle.stop();
    expect(overruns).toHaveLength(0);
  });
});

describe("runWakerCycle — per-cycle budget", () => {
  const manyConvs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i}`, contactId: "x",
      updatedAt: `2026-07-23T${String(10 + i).padStart(2, "0")}:00:00Z`,
      assistant: { id: "A" },
    }));

  function slowDeps(convCount: number, perCallMs: number, budgetMs: number) {
    const db = openDb(":memory:");
    const looked: string[] = [];
    return {
      looked,
      deps: {
        v3: {
          listConversations: async () => manyConvs(convCount),
          listMessages: async (id: string) => {
            looked.push(id);
            await new Promise((res) => setTimeout(res, perCallMs));
            return [];
          },
          chatCompletion: async () => ({ ok: true as const }),
          assignTool: async () => ({ ok: true as const }),
        },
        processed: createProcessedStore(db),
        events: createEventStore(db),
        state: new Map<string, string>([["t1", "2026-07-23T00:00:00Z"]]),
        budgetMs,
      },
    };
  }

  it("stops early and leaves the rest for the next cycle", async () => {
    const { deps, looked } = slowDeps(10, 12, 30);
    await runWakerCycle(deps as never, tenant);
    // Bounded well below all 10 — one slow tenant must not hold its slot for
    // the whole list while every other tenant waits behind it.
    expect(looked.length).toBeGreaterThan(0);
    expect(looked.length).toBeLessThan(10);
    expect(deps.events.latest("t1", 20).some((e) => e.kind === "poll_budget")).toBe(true);

    // The cursor stopped at the last FINISHED conversation, so the untouched
    // ones are still pending — the next cycle resumes exactly there.
    const resumed = deps.state.get("t1") ?? "";
    expect(resumed < "2026-07-23T19:00:00Z").toBe(true);
    const before = looked.length;
    await runWakerCycle(deps as never, tenant);
    expect(looked.length).toBeGreaterThan(before);
  });

  it("always makes progress even when the budget is smaller than one round-trip", async () => {
    // Guards against a livelock: budget 0 must not mean "never advance".
    const { deps, looked } = slowDeps(5, 5, 0);
    await runWakerCycle(deps as never, tenant);
    expect(looked).toEqual(["c0"]);
    expect(deps.state.get("t1")).toBe("2026-07-23T10:00:00Z");
  });
});

describe("reactions are recognised and ignored", () => {
  const reactionMsg = (id: string) =>
    ({ id, content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t", type: "TEXT" });
  const imageMsg = (id: string) =>
    ({ id, content: null, ai: false, source: "USER", channel: "whatsapp", createdAt: "t", type: "IMAGE" });

  it("classifies by message type, defaulting to media when type is absent", () => {
    // Absent type must stay media: an unknown type must never silently downgrade
    // a working voice-note wake into something we skip.
    expect(classifyEmptyInbound({})).toBe("media");
    expect(classifyEmptyInbound({ type: null })).toBe("media");
    for (const t of ["IMAGE", "AUDIO", "FILE", "VIDEO", "image", "audio"]) {
      expect(classifyEmptyInbound({ type: t })).toBe("media");
    }
    expect(classifyEmptyInbound({ type: "TEXT" })).toBe("ambiguous");
  });

  it("never wakes the assistant for a reaction", async () => {
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const { deps, wakes, assigns } = make("2026-07-23T10:00:00Z", [reactionMsg("r1")]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    const r = await runWakerCycle(deps as never, withTool);

    expect(r.woken).toBe(0);
    expect(wakes).toHaveLength(0);
    expect(assigns).toHaveLength(0);
  });

  it("marks reactions processed so they are not re-detected every cycle", async () => {
    const { deps } = make("2026-07-23T10:00:00Z", [reactionMsg("r1")]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, tenant);

    expect(deps.processed.has("t1", "waker:r1")).toBe(true);
    expect(deps.events.latest("t1", 10).some(
      (e) => e.detail.includes("reactions=1") && e.detail.includes("ignored")
    )).toBe(true);
  });

  it("wakes on an unreadable type when the contact really does have an attachment", async () => {
    // The live bug (account Dalmata, 2026-08-21): a WhatsApp VOICE NOTE arrived
    // carrying type TEXT, was called a reaction, and was dropped in silence. The
    // type is not evidence either way — the CRM is.
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [reactionMsg("v1")], {
      contactHasAttachments: true,
    });
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    const r = await runWakerCycle(deps as never, withTool);

    expect(r.woken).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(deps.events.latest("t1", 10).some(
      (e) => e.detail.includes("attachments found")
    )).toBe(true);
  });

  it("hands the assistant the transcript, not an instruction to fetch it", async () => {
    // Live (Dalmata, 2026-08-21): three voice notes, three correct wakes, zero
    // tool calls. A media-only message has no content, so agent-run drops it
    // from history, ensureRespondableTail appends "Output ONLY the message
    // text", and that final user turn beats any system-prompt request to call a
    // tool. Reading it ourselves removes the decision entirely.
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [reactionMsg("v1")], {
      contactHasAttachments: true,
    });
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, withTool);

    expect(wakes).toHaveLength(1);
    expect(wakes[0].additionalInstructions).toContain("departamentos en Ñuñoa");
    expect(wakes[0].additionalInstructions).toMatch(/Reply to the contact/i);
    // It must not ask for a tool call — that is the request the model ignores.
    expect(wakes[0].additionalInstructions).not.toMatch(/call the analyze_attachment tool/i);
  });

  it("wakes rather than drops when the attachment lookup fails", async () => {
    // Failing closed loses a customer's voice note silently. Failing open costs
    // one wake where the tool reports it found nothing.
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const { deps, wakes } = make("2026-07-23T10:00:00Z", [reactionMsg("v1")]);
    deps.ghl.latestMediaMessages = async () => { throw new Error("ghl down"); };
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, withTool);

    expect(wakes).toHaveLength(1);
  });

  it("names the ignored type, because this is the branch that silently drops a message", () => {
    // A real attachment misfiled as a reaction looks identical to a thumbs-up
    // on the dashboard unless the type is in the event.
    return (async () => {
      const { deps } = make("2026-07-23T10:00:00Z", [reactionMsg("r1")]);
      deps.state.set("t1", "2026-07-23T09:00:00Z");
      await runWakerCycle(deps as never, tenant);
      const detect = deps.events.latest("t1", 10).find((e) => e.detail.includes("reactions=1"));
      expect(detect?.detail).toMatch(/types=/);
    })();
  });

  it("still wakes on a burst that mixes an attachment with a reaction", async () => {
    // The photo is the whole point of the bridge; a reaction alongside it must
    // not suppress reading it.
    const withTool = { ...tenant, toolId: "tool-1" } as Tenant;
    const { deps, wakes, assigns } = make("2026-07-23T10:00:00Z", [imageMsg("m1"), reactionMsg("r1")]);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    const r = await runWakerCycle(deps as never, withTool);

    expect(r.woken).toBe(1);
    expect(wakes[0].additionalInstructions).toContain("[media-mcp]");
    expect(assigns).toHaveLength(1);
    expect(deps.processed.has("t1", "waker:r1")).toBe(true);
  });

  it("an ignored reaction never blocks a later real attachment", async () => {
    const msgs = [reactionMsg("r1")];
    const { deps, wakes } = make("2026-07-23T10:00:00Z", msgs);
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, tenant);
    expect(wakes).toHaveLength(0);

    msgs.push(imageMsg("m1"));
    deps.state.set("t1", "2026-07-23T09:00:00Z");
    await runWakerCycle(deps as never, tenant);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].additionalInstructions).toContain("[media-mcp]");
  });
});

describe("revoked key does not poll forever", () => {
  const paused = () => {
    const calls: Array<{ id: string; consecutive: number; lastError: string }> = [];
    return {
      calls,
      onAuthFailures: (i: { tenant: Tenant; consecutive: number; lastError: string }) =>
        calls.push({ id: i.tenant.id, consecutive: i.consecutive, lastError: i.lastError }),
    };
  };

  it("classifies only auth failures as permanent", () => {
    for (const m of [
      "v3 listConversations HTTP 401 (unauthorized: bad key)",
      "v3 listConversations HTTP 403 (forbidden)",
      "Unauthorized",
      "invalid api key",
    ]) expect(isAuthFailure(m)).toBe(true);
    // A transient failure SHOULD keep retrying — pausing on it would take a
    // healthy subaccount offline until a human noticed.
    for (const m of [
      "v3 listConversations HTTP 500",
      "timed out after 15000ms",
      "network error",
      "v3 listConversations HTTP 429",
    ]) expect(isAuthFailure(m)).toBe(false);
  });

  it("hands the tenant off to be paused after repeated auth failures", async () => {
    const p = paused();
    const handle = startWaker(
      async () => { throw new Error("v3 listConversations HTTP 401 (unauthorized)"); },
      () => [tenant],
      2,
      { onAuthFailures: p.onAuthFailures, authFailureLimit: 3, onOverrun: () => {} }
    );
    await until(() => p.calls.length > 0);
    handle.stop();
    expect(p.calls.length).toBeGreaterThan(0);
    expect(p.calls[0]).toMatchObject({ id: "t1", consecutive: 3 });
    expect(p.calls[0].lastError).toMatch(/401/);
  });

  it("never pauses on transient failures, however many", async () => {
    const p = paused();
    const handle = startWaker(
      async () => { throw new Error("v3 listConversations HTTP 500"); },
      () => [tenant],
      2,
      { onAuthFailures: p.onAuthFailures, authFailureLimit: 3, onOverrun: () => {} }
    );
    await new Promise((res) => setTimeout(res, 60));
    handle.stop();
    expect(p.calls).toHaveLength(0);
  });

  it("a successful poll clears the streak", async () => {
    const p = paused();
    let n = 0;
    const handle = startWaker(
      async () => {
        n += 1;
        // fail, fail, succeed, fail, fail... never three in a row
        if (n % 3 === 0) return { woken: 0 };
        throw new Error("HTTP 401");
      },
      () => [tenant],
      2,
      { onAuthFailures: p.onAuthFailures, authFailureLimit: 3, onOverrun: () => {} }
    );
    await until(() => n >= 9);
    handle.stop();
    expect(n).toBeGreaterThanOrEqual(9); // it really did keep polling
    expect(p.calls).toHaveLength(0);
  });

  it("one tenant's dead key never pauses another", async () => {
    const p = paused();
    const good = { ...tenant, id: "good" } as Tenant;
    const bad = { ...tenant, id: "bad" } as Tenant;
    const handle = startWaker(
      async (t) => {
        if (t.id === "bad") throw new Error("HTTP 401 unauthorized");
        return { woken: 0 };
      },
      () => [good, bad],
      2,
      { onAuthFailures: p.onAuthFailures, authFailureLimit: 3, onOverrun: () => {} }
    );
    await new Promise((res) => setTimeout(res, 60));
    handle.stop();
    expect(p.calls.every((c) => c.id === "bad")).toBe(true);
    expect(p.calls.length).toBeGreaterThan(0);
  });
});
