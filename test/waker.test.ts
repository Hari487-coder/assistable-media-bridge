import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { createEventStore } from "../src/store/events";
import { createProcessedStore } from "../src/store/processed";
import { runWakerCycle, startWaker } from "../src/core/waker";
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

function make(convUpdatedAt: string, messages: ReturnType<typeof msg>[]) {
  const db = openDb(":memory:");
  const wakes: Array<{ assistantId: string; conversationId: string; additionalInstructions: string }> = [];
  const deps = {
    v3: {
      listConversations: async () => [
        { id: "c1", contactId: "ct1", updatedAt: convUpdatedAt, assistant: { id: "A_conv" } },
      ],
      listMessages: async () => messages,
      chatCompletion: async (a: typeof wakes[number]) => { wakes.push(a); return { ok: true as const }; },
    },
    processed: createProcessedStore(db),
    events: createEventStore(db),
    state: new Map<string, string>(),
  };
  return { deps, wakes };
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
    const handle = startWaker(cycleFor, () => tenants, 1);
    await new Promise((res) => setTimeout(res, 40));
    handle.stop();
    expect(seen).toContain("on");
    expect(seen).not.toContain("disabled");
    expect(seen).not.toContain("wakeroff");
    expect(maxInFlight).toBe(1); // reentrancy guard held
  });
});
