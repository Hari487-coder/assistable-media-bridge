import { describe, expect, it } from "vitest";
import { sniff } from "../src/media/sniff";
import { downloadMedia } from "../src/media/download";

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe("sniff", () => {
  it("detects common types by magic bytes", () => {
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0)).mime).toBe("image/jpeg");
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47)).mime).toBe("image/png");
    expect(sniff(new TextEncoder().encode("OggS....")).mime).toBe("audio/ogg");
    expect(sniff(new TextEncoder().encode("%PDF-1.7")).kind).toBe("pdf");
    expect(sniff(new TextEncoder().encode("ID3\x03tag")).mime).toBe("audio/mpeg");
    expect(sniff(bytes(1, 2, 3)).kind).toBe("unknown");
  });
  it("splits the ftyp family by major brand: voice memos are audio, camera videos are video", () => {
    // The live failure: an iPhone/WhatsApp video is an MP4 too, and calling it
    // audio fed the tester's video to the model as a voice note.
    const ftyp = (brand: string) => {
      const b = new Uint8Array(16);
      b.set(new TextEncoder().encode("ftyp"), 4);
      b.set(new TextEncoder().encode(brand), 8);
      return b;
    };
    expect(sniff(ftyp("M4A "))).toEqual({ kind: "audio", mime: "audio/mp4" });
    expect(sniff(ftyp("isom"))).toEqual({ kind: "video", mime: "video/mp4" });
    expect(sniff(ftyp("mp42"))).toEqual({ kind: "video", mime: "video/mp4" });
    expect(sniff(ftyp("3gp4"))).toEqual({ kind: "video", mime: "video/3gpp" });
    expect(sniff(ftyp("qt  "))).toEqual({ kind: "video", mime: "video/quicktime" });
  });
  it("detects webp vs wav (RIFF disambiguation)", () => {
    const webp = new Uint8Array(12);
    webp.set(new TextEncoder().encode("RIFF"), 0); webp.set(new TextEncoder().encode("WEBP"), 8);
    const wav = new Uint8Array(12);
    wav.set(new TextEncoder().encode("RIFF"), 0); wav.set(new TextEncoder().encode("WAVE"), 8);
    expect(sniff(webp).mime).toBe("image/webp");
    expect(sniff(wav).mime).toBe("audio/wav");
  });
});

describe("downloadMedia", () => {
  const ok = (body: Uint8Array) => (async () => new Response(body as any)) as unknown as typeof fetch;
  it("rejects non-allowlisted hosts without fetching", async () => {
    let fetched = false;
    const spy = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const r = await downloadMedia("https://evil.example.com/a.ogg", { fetchImpl: spy });
    expect(r).toEqual({ error: "disallowed_host" });
    expect(fetched).toBe(false);
  });
  it("allows GCS — GHL rehosts SMS/MMS media on storage.googleapis.com", async () => {
    const r = await downloadMedia("https://storage.googleapis.com/some-ghl-bucket/img.jpg", {
      fetchImpl: ok(new Uint8Array(5)),
    });
    expect("bytes" in r && r.bytes.length).toBe(5);
    // googleapis.com in general stays blocked — only the storage host is trusted.
    const other = await downloadMedia("https://compute.googleapis.com/x", { fetchImpl: ok(new Uint8Array(1)) });
    expect(other).toEqual({ error: "disallowed_host" });
  });
  it("downloads from GHL CDN and enforces cap", async () => {
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: ok(new Uint8Array(10)) });
    expect("bytes" in r && r.bytes.length).toBe(10);
    const big = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
      fetchImpl: ok(new Uint8Array(50)), maxBytes: 40,
    });
    expect(big).toEqual({ error: "too_large" });
  });
  it("does not follow redirects — 3xx from an allowed host fails closed", async () => {
    let redirectMode: string | undefined;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } });
    }) as unknown as typeof fetch;
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: impl });
    expect(r).toEqual({ error: "fetch_failed" });
    expect(redirectMode).toBe("manual");
  });
  it("rejects oversize via content-length pre-check", async () => {
    // Body is tiny (under the cap) — only the content-length pre-check can
    // produce too_large here; the streaming cap alone would return bytes.
    const impl = (async () =>
      new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "999999999" } })
    ) as unknown as typeof fetch;
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: impl, maxBytes: 100 });
    expect(r).toEqual({ error: "too_large" });
  });
});
