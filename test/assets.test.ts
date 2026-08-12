import { describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { MAX_ASSETS, createAssetStore } from "../src/store/assets";
import { normalizeAssetName, validateAssetUrl } from "../src/core/asset-url";

const store = () => createAssetStore(openDb(":memory:"));
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const head = (contentType: string | null, ok = true) =>
  (async () => new Response(null, {
    status: ok ? 200 : 404,
    headers: contentType ? { "content-type": contentType } : {},
  })) as unknown as typeof fetch;

const asset = (over: Partial<Parameters<ReturnType<typeof store>["add"]>[1]> = {}) => ({
  name: "demo-video", description: "60s product walkthrough",
  kind: "video" as const, url: "https://cdn.example.com/demo.mp4", ...over,
});

describe("asset names", () => {
  it("slugs to a stable lowercase form the model can quote back", () => {
    expect(normalizeAssetName("  Demo Video  ")).toBe("demo-video");
    expect(normalizeAssetName("Pricing_Sheet.PDF")).toBe("pricing-sheet-pdf");
    expect(normalizeAssetName("50% OFF!!")).toBe("50-off");
    // Collapsed separators must not produce leading/trailing dashes.
    expect(normalizeAssetName("--a  b--")).toBe("a-b");
  });
  it("rejects a name that slugs to nothing", () => {
    expect(normalizeAssetName("!!!")).toBe("");
  });
});

describe("asset URL validation", () => {
  it("accepts a public https URL and classifies it by content type", async () => {
    const r = await validateAssetUrl("https://cdn.example.com/a.mp4", {
      fetchImpl: head("video/mp4"), lookupImpl: publicLookup,
    });
    expect(r).toEqual({ ok: true, kind: "video" });
  });
  it("classifies each supported kind", async () => {
    const cases: Array<[string, string]> = [
      ["image/png", "image"], ["video/mp4", "video"], ["audio/ogg", "audio"],
      ["application/pdf", "document"], ["application/msword", "document"],
    ];
    for (const [ct, kind] of cases) {
      const r = await validateAssetUrl("https://cdn.example.com/a", {
        fetchImpl: head(ct), lookupImpl: publicLookup,
      });
      expect(r, ct).toEqual({ ok: true, kind });
    }
  });
  it("falls back to the file extension when the server sends no content type", async () => {
    const r = await validateAssetUrl("https://cdn.example.com/clip.mp4", {
      fetchImpl: head(null), lookupImpl: publicLookup,
    });
    expect(r).toEqual({ ok: true, kind: "video" });
  });
  it("refuses a URL whose host resolves to a private address", async () => {
    // Otherwise a tenant could register an internal URL and have GHL fetch it.
    const r = await validateAssetUrl("https://internal.example.com/a.png", {
      fetchImpl: head("image/png"),
      lookupImpl: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    expect(r.ok).toBe(false);
    expect("error" in r && r.error).toMatch(/private/i);
  });
  it("refuses non-http schemes", async () => {
    const r = await validateAssetUrl("file:///etc/passwd", {
      fetchImpl: head("text/plain"), lookupImpl: publicLookup,
    });
    expect(r.ok).toBe(false);
  });
  it("refuses an unreachable URL at registration rather than in front of a lead", async () => {
    const r = await validateAssetUrl("https://cdn.example.com/gone.mp4", {
      fetchImpl: head("video/mp4", false), lookupImpl: publicLookup,
    });
    expect(r.ok).toBe(false);
    expect("error" in r && r.error).toMatch(/could not be reached|404/i);
  });
  it("refuses a type nothing can send", async () => {
    const r = await validateAssetUrl("https://cdn.example.com/a.exe", {
      fetchImpl: head("application/x-msdownload"), lookupImpl: publicLookup,
    });
    expect(r.ok).toBe(false);
  });
});

describe("asset store", () => {
  it("adds and lists per tenant, newest last", () => {
    const s = store();
    s.add("t1", asset());
    s.add("t1", asset({ name: "price-sheet", kind: "document", url: "https://cdn.example.com/p.pdf" }));
    s.add("t2", asset({ name: "other-tenant" }));
    expect(s.list("t1").map((a) => a.name)).toEqual(["demo-video", "price-sheet"]);
    expect(s.list("t2").map((a) => a.name)).toEqual(["other-tenant"]);
  });
  it("looks an asset up by name, scoped to the tenant", () => {
    const s = store();
    s.add("t1", asset());
    expect(s.get("t1", "demo-video")?.url).toBe("https://cdn.example.com/demo.mp4");
    expect(s.get("t2", "demo-video")).toBeNull();
    expect(s.get("t1", "nope")).toBeNull();
  });
  it("treats a re-added name as an update, not a duplicate", () => {
    const s = store();
    s.add("t1", asset());
    s.add("t1", asset({ description: "new copy", url: "https://cdn.example.com/v2.mp4" }));
    expect(s.list("t1")).toHaveLength(1);
    expect(s.get("t1", "demo-video")?.description).toBe("new copy");
  });
  it("caps the library so the tool description stays bounded", () => {
    const s = store();
    for (let i = 0; i < MAX_ASSETS; i += 1) s.add("t1", asset({ name: `a-${i}` }));
    expect(() => s.add("t1", asset({ name: "one-too-many" }))).toThrow(/20|limit/i);
    // Updating an existing asset at the cap is still allowed.
    expect(() => s.add("t1", asset({ name: "a-0", description: "edited" }))).not.toThrow();
  });
  it("removes only the named asset for that tenant", () => {
    const s = store();
    s.add("t1", asset());
    s.add("t2", asset());
    expect(s.remove("t1", "demo-video")).toBe(true);
    expect(s.list("t1")).toHaveLength(0);
    expect(s.list("t2")).toHaveLength(1);
    expect(s.remove("t1", "demo-video")).toBe(false);
  });
});
