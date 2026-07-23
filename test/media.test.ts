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
    const m4a = new Uint8Array(12); m4a.set(new TextEncoder().encode("ftyp"), 4);
    expect(sniff(m4a).mime).toBe("audio/mp4");
    expect(sniff(bytes(1, 2, 3)).kind).toBe("unknown");
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
  it("downloads from GHL CDN and enforces cap", async () => {
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: ok(new Uint8Array(10)) });
    expect("bytes" in r && r.bytes.length).toBe(10);
    const big = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
      fetchImpl: ok(new Uint8Array(50)), maxBytes: 40,
    });
    expect(big).toEqual({ error: "too_large" });
  });
});
