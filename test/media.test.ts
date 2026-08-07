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
  it("classifies the ftyp family by its TRACKS, not its container brand", () => {
    // Two live failures, opposite directions: an iPhone/WhatsApp camera video
    // was fed to the model as a voice note (soundtrack only), and an Instagram
    // VOICE NOTE — which arrives in a generic-brand MP4 video container — was
    // treated as a video. The hdlr track handlers are the truth.
    const enc = new TextEncoder();
    const ftyp = (brand: string, ...handlers: string[]) => {
      const b = new Uint8Array(16 + handlers.length * 20);
      b.set(enc.encode("ftyp"), 4);
      b.set(enc.encode(brand), 8);
      // Minimal hdlr shape: tag, then handler type 12 bytes later.
      handlers.forEach((h, i) => {
        const at = 16 + i * 20;
        b.set(enc.encode("hdlr"), at);
        b.set(enc.encode(h), at + 12);
      });
      return b;
    };
    // M4A-brand voice memos short-circuit on the brand alone.
    expect(sniff(ftyp("M4A "))).toEqual({ kind: "audio", mime: "audio/mp4" });
    // Instagram voice note: generic video brand, sound track only → audio.
    expect(sniff(ftyp("isom", "soun"))).toEqual({ kind: "audio", mime: "audio/mp4" });
    expect(sniff(ftyp("mp42", "soun"))).toEqual({ kind: "audio", mime: "audio/mp4" });
    // Camera video: a vide track (with or without sound) → video.
    expect(sniff(ftyp("isom", "vide", "soun"))).toEqual({ kind: "video", mime: "video/mp4" });
    expect(sniff(ftyp("3gp4", "vide"))).toEqual({ kind: "video", mime: "video/3gpp" });
    expect(sniff(ftyp("qt  ", "vide", "soun"))).toEqual({ kind: "video", mime: "video/quicktime" });
    // No readable hdlr (truncated moov) → fall back to the brand's video call.
    expect(sniff(ftyp("isom"))).toEqual({ kind: "video", mime: "video/mp4" });
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
  it("allows Meta's CDN — Instagram/Messenger attachments are not rehosted by GHL", async () => {
    // Live: an Instagram voice note reached the tool and died on
    // disallowed_host with the whole rest of the pipeline working.
    for (const url of [
      "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123",
      "https://scontent.cdninstagram.com/v/t1/audio.mp4",
      "https://video-lhr8-1.xx.fbcdn.net/v/t42/clip.mp4",
    ]) {
      const r = await downloadMedia(url, { fetchImpl: ok(new Uint8Array(7)) });
      expect("bytes" in r && r.bytes.length, url).toBe(7);
    }
    // Lookalike domains must still fail closed — suffix match, not substring.
    const spoof = await downloadMedia("https://fbcdn.net.evil.example.com/x", {
      fetchImpl: ok(new Uint8Array(1)),
    });
    expect(spoof).toEqual({ error: "disallowed_host" });
  });
  it("keeps an unattributable 'internal-looking' host blocked — naming it in a trace is not a reason to trust it", async () => {
    // Live 2026-08-07: this host arrived as an Instagram attachment URL. It is
    // not Meta's, not GHL's, not Assistable's — a cheap-TLD, Cloudflare-fronted
    // domain with a DV-only cert, named to read as internal infrastructure.
    // The allowlist is the only gate between an inbound message and a fetch
    // from our server, so this stays blocked until someone attributes it.
    let fetched = false;
    const spy = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const r = await downloadMedia(
      "https://static-assets.internal.usercontent.site/ig/asset.mp4", { fetchImpl: spy }
    );
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
