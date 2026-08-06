import { describe, expect, it } from "vitest";
import { MAX_BATCH_ROWS, parseBatchRows, provisionBatch, redactPits } from "../src/core/batch";
import { openDb } from "../src/db";
import { createTenantStore } from "../src/store/tenants";

const shared = {
  provider: "gemini" as const, v3Key: "ask_live_k", ghlPit: "pit", aiKey: "gk",
};

// Per-subaccount fakes: `assistants` lets a row be ambiguous/empty, `failPit`
// makes one location's GHL check fail without touching the others.
function makeCtx(opts: {
  assistants?: Record<string, Array<{ id: string; name: string }>>;
  failPitFor?: string[];
} = {}) {
  const db = openDb(":memory:");
  const tenants = createTenantStore(db, Buffer.alloc(32, 5));
  const seenSubs: string[] = [];
  const seenPits: string[] = [];
  const ctx = {
    tenants,
    publicBaseUrl: "https://media.example.com",
    v3Factory: (_key: string, subAccountId?: string) => {
      if (subAccountId) seenSubs.push(subAccountId);
      const list = opts.assistants?.[subAccountId ?? ""] ?? [{ id: "asst_default", name: "Bot" }];
      return {
        validateKey: async () => ({ ok: true as const }),
        listAssistants: async () => list,
        createTool: async () => ({ id: `tool_${subAccountId}`, conflict: false as const, raw: {} }),
        findToolByName: async () => `tool_${subAccountId}`,
        assignTool: async () => ({ ok: true as const }),
        updateToolUrl: async () => ({ ok: true as const }),
      };
    },
    ghlFactory: (pit: string) => {
      seenPits.push(pit);
      return {
        validatePit: async (locationId: string) =>
          (opts.failPitFor ?? []).includes(locationId)
            ? { ok: false as const, status: 401 }
            : { ok: true as const },
      };
    },
    providerFactory: () => ({
      validateKey: async () => ({ ok: true as const }), describe: async () => "",
    }),
  };
  return { ctx, tenants, seenSubs, seenPits };
}

describe("parseBatchRows", () => {
  it("parses commas, tabs, optional fields, comments and blank lines", () => {
    const { rows, errors } = parseBatchRows([
      "# subaccount, location, assistant, label",
      "sub_1, loc_1, asst_1, Main Street Dental",
      "sub_2\tloc_2\t\tRiverside",
      "",
      "sub_3,loc_3",
      "   ",
    ].join("\n"));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { subAccountId: "sub_1", locationId: "loc_1", assistantId: "asst_1", label: "Main Street Dental" },
      { subAccountId: "sub_2", locationId: "loc_2", label: "Riverside" },
      { subAccountId: "sub_3", locationId: "loc_3" },
    ]);
  });
  it("keeps a comma inside a business name as part of the label", () => {
    const { rows } = parseBatchRows("sub_1, loc_1, asst_1, Main Street Dental, PC");
    expect(rows[0].label).toBe("Main Street Dental, PC");
  });
  it("reports a malformed line without discarding the good ones", () => {
    const { rows, errors } = parseBatchRows("sub_1, loc_1\nbroken\nsub_2, loc_2");
    expect(rows).toHaveLength(2);
    expect(errors).toEqual([
      { line: 2, text: "broken", error: "expected at least: subAccountId, locationId" },
    ]);
  });
  it("extracts pit= from any position without disturbing positional fields", () => {
    const { rows, errors } = parseBatchRows([
      "sub_1, loc_1, asst_1, Main Street Dental, PC, pit=tok-a",
      "sub_2, pit=tok-b, loc_2, asst_2, Riverside",
      "sub_3, loc_3",
    ].join("\n"));
    expect(errors).toEqual([]);
    // The label must still absorb its trailing comma — that is exactly why the
    // token is keyed rather than a fifth positional column.
    expect(rows[0]).toEqual({
      subAccountId: "sub_1", locationId: "loc_1", assistantId: "asst_1",
      label: "Main Street Dental, PC", ghlPit: "tok-a",
    });
    expect(rows[1]).toEqual({
      subAccountId: "sub_2", locationId: "loc_2", assistantId: "asst_2",
      label: "Riverside", ghlPit: "tok-b",
    });
    expect(rows[2].ghlPit).toBeUndefined();
  });
  it("keeps a live token out of the echoed error text", () => {
    const { errors } = parseBatchRows("broken, pit=super-secret-token");
    expect(errors[0].text).not.toContain("super-secret-token");
    expect(errors[0].text).toContain("pit=");
  });
  it("redacts pit values while preserving row shape", () => {
    expect(redactPits("sub_1, loc_1, pit=tok-a\nsub_2, loc_2, pit = tok-b"))
      .toBe("sub_1, loc_1, pit=\nsub_2, loc_2, pit=");
    expect(redactPits("sub_1, loc_1")).toBe("sub_1, loc_1");
  });
  it("refuses a list over the per-submission ceiling", () => {
    const text = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, i) => `sub_${i}, loc_${i}`).join("\n");
    const { rows, errors } = parseBatchRows(text);
    expect(rows).toEqual([]);
    expect(errors[0].error).toMatch(/per-submission limit/);
  });
});

describe("provisionBatch", () => {
  it("connects every row against its own subaccount, sharing one credential set", async () => {
    const { ctx, tenants, seenSubs } = makeCtx();
    const { rows } = parseBatchRows("sub_1, loc_1, asst_default, A\nsub_2, loc_2, asst_default, B");
    const out = await provisionBatch(ctx as never, shared, rows);

    expect(out.every((r) => r.ok)).toBe(true);
    expect(out.map((r) => r.toolId)).toEqual(["tool_sub_1", "tool_sub_2"]);
    // Each row must be scoped to ITS subaccount — a shared workspace key that
    // forgets the subaccount silently provisions into the wrong one.
    expect(new Set(seenSubs)).toEqual(new Set(["sub_1", "sub_2"]));
    expect(tenants.list()).toHaveLength(2);
    expect(tenants.getByLocationId("loc_2")?.subAccountId).toBe("sub_2");
  });
  it("preserves input order even though rows run concurrently", async () => {
    const { ctx } = makeCtx();
    const text = Array.from({ length: 9 }, (_, i) => `sub_${i}, loc_${i}`).join("\n");
    const { rows } = parseBatchRows(text);
    const out = await provisionBatch(ctx as never, shared, rows);
    expect(out.map((r) => r.row.locationId)).toEqual(rows.map((r) => r.locationId));
  });
  it("fills in the assistant when the subaccount has exactly one", async () => {
    const { ctx } = makeCtx({ assistants: { sub_1: [{ id: "only_one", name: "Solo" }] } });
    const { rows } = parseBatchRows("sub_1, loc_1");
    const out = await provisionBatch(ctx as never, shared, rows);
    expect(out[0].ok).toBe(true);
    expect(out[0].assistantId).toBe("only_one");
  });
  it("fails the row, listing the choices, when the assistant is ambiguous", async () => {
    const { ctx, tenants } = makeCtx({
      assistants: { sub_1: [{ id: "a1", name: "Sales" }, { id: "a2", name: "Support" }] },
    });
    const { rows } = parseBatchRows("sub_1, loc_1");
    const out = await provisionBatch(ctx as never, shared, rows);
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toMatch(/a1 \(Sales\)/);
    expect(out[0].error).toMatch(/a2 \(Support\)/);
    // Guessing would silently wire media into the wrong bot — nothing is saved.
    expect(tenants.list()).toHaveLength(0);
  });
  it("isolates a failing row so the rest of the batch still connects", async () => {
    const { ctx, tenants } = makeCtx({ failPitFor: ["loc_2"] });
    const { rows } = parseBatchRows(
      "sub_1, loc_1, asst_default\nsub_2, loc_2, asst_default\nsub_3, loc_3, asst_default"
    );
    const out = await provisionBatch(ctx as never, shared, rows);

    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out[1].error).toMatch(/GHL/i);
    expect(tenants.list().map((t) => t.locationId).sort()).toEqual(["loc_1", "loc_3"]);
  });
  it("uses the per-row token when present, otherwise the shared one", async () => {
    // Whether a GHL private integration is agency-wide or per-location depends
    // on how it was minted, so both must work — including a mixed list.
    const { ctx, seenPits } = makeCtx();
    const { rows } = parseBatchRows(
      "sub_1, loc_1, asst_default\nsub_2, loc_2, asst_default, Two, pit=own-token"
    );
    const out = await provisionBatch(ctx as never, shared, rows);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(seenPits.sort()).toEqual(["own-token", shared.ghlPit].sort());
  });
  it("works with NO shared token when every row carries its own", async () => {
    const { ctx, tenants } = makeCtx();
    const { rows } = parseBatchRows(
      "sub_1, loc_1, asst_default, One, pit=tok-1\nsub_2, loc_2, asst_default, Two, pit=tok-2"
    );
    const out = await provisionBatch(ctx as never, { ...shared, ghlPit: undefined }, rows);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(tenants.getByLocationId("loc_1")?.ghlPit).toBe("tok-1");
    expect(tenants.getByLocationId("loc_2")?.ghlPit).toBe("tok-2");
  });
  it("fails only the rows left with no token at all", async () => {
    const { ctx, tenants } = makeCtx();
    const { rows } = parseBatchRows(
      "sub_1, loc_1, asst_default, One, pit=tok-1\nsub_2, loc_2, asst_default, Two"
    );
    const out = await provisionBatch(ctx as never, { ...shared, ghlPit: undefined }, rows);
    expect(out.map((r) => r.ok)).toEqual([true, false]);
    expect(out[1].error).toMatch(/pit=<token>/);
    expect(tenants.list()).toHaveLength(1);
  });
  it("blames the subaccount id, not a missing assistant, when the subaccount is empty", async () => {
    // "This subaccount has no assistants, create one first" was actively
    // misleading: the likelier cause is that the column holds a CRM location id.
    const { ctx } = makeCtx({ assistants: { nYsYTNNoV948IVhNfmOj: [] } });
    const { rows } = parseBatchRows("nYsYTNNoV948IVhNfmOj, loc_1");
    const out = await provisionBatch(ctx as never, shared, rows);
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toMatch(/no assistants are visible in subaccount/);
    expect(out[0].error).toMatch(/NOT the CRM location id/);
  });
  it("fails the row when the location id was pasted into the subaccount column", async () => {
    // The exact shape of a real onboarding attempt: same value in both columns
    // on every row.
    const { ctx, tenants } = makeCtx();
    const { rows } = parseBatchRows([
      "nYsYTNNoV948IVhNfmOj, nYsYTNNoV948IVhNfmOj, asst_default, One",
      "clx7k2p9a0001qw8h3n5v, kQ2mNb71xTfLpR3wZaYd, asst_default, Two",
    ].join("\n"));
    const out = await provisionBatch(ctx as never, shared, rows);

    expect(out.map((r) => r.ok)).toEqual([false, true]);
    expect(out[0].error).toMatch(/different identifiers/i);
    expect(out[0].error).toMatch(/portal/); // tells them where to find the real one
    // The good row is untouched — one bad paste must not sink the batch.
    expect(tenants.list().map((t) => t.locationId)).toEqual(["kQ2mNb71xTfLpR3wZaYd"]);
  });
  it("is re-runnable: a repeat batch reconnects instead of duplicating", async () => {
    const { ctx, tenants } = makeCtx({ failPitFor: ["loc_2"] });
    const { rows } = parseBatchRows("sub_1, loc_1, asst_default\nsub_2, loc_2, asst_default");

    const first = await provisionBatch(ctx as never, shared, rows);
    expect(first.map((r) => r.ok)).toEqual([true, false]);
    const tokenBefore = tenants.getByLocationId("loc_1")?.token;

    // The operator fixes loc_2's PIT and pastes the WHOLE list again — the
    // intended workflow. loc_1 must reconnect in place, not double up.
    const { ctx: healed } = makeCtx(); // same store, PIT no longer failing
    healed.tenants = tenants;
    const second = await provisionBatch(healed as never, shared, rows);

    expect(second.map((r) => r.ok)).toEqual([true, true]);
    expect(second[0].reconnected).toBe(true);
    expect(second[1].reconnected).toBe(false);
    expect(tenants.list()).toHaveLength(2);
    expect(tenants.getByLocationId("loc_1")?.token).toBe(tokenBefore);
  });
});
