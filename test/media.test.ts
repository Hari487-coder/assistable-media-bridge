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
  // Unit runs must never depend on real DNS: every allowlisted host resolves
  // to a public address unless a test says otherwise.
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  it("rejects non-allowlisted hosts without fetching", async () => {
    let fetched = false;
    const spy = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
    const r = await downloadMedia("https://evil.example.com/a.ogg", { fetchImpl: spy, lookupImpl: publicLookup });
    expect(r).toEqual({ error: "disallowed_host" });
    expect(fetched).toBe(false);
  });
  it("allows GCS — GHL rehosts SMS/MMS media on storage.googleapis.com", async () => {
    const r = await downloadMedia("https://storage.googleapis.com/some-ghl-bucket/img.jpg", {
      fetchImpl: ok(new Uint8Array(5)), lookupImpl: publicLookup,
    });
    expect("bytes" in r && r.bytes.length).toBe(5);
    // googleapis.com in general stays blocked — only the storage host is trusted.
    const other = await downloadMedia("https://compute.googleapis.com/x", { fetchImpl: ok(new Uint8Array(1)), lookupImpl: publicLookup });
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
      const r = await downloadMedia(url, { fetchImpl: ok(new Uint8Array(7)), lookupImpl: publicLookup });
      expect("bytes" in r && r.bytes.length, url).toBe(7);
    }
    // Lookalike domains must still fail closed — suffix match, not substring.
    const spoof = await downloadMedia("https://fbcdn.net.evil.example.com/x", {
      fetchImpl: ok(new Uint8Array(1)), lookupImpl: publicLookup,
    });
    expect(spoof).toEqual({ error: "disallowed_host" });
  });
  it("allows the Instagram media host, scoped to the internal. subtree only", async () => {
    // Live 2026-08-07: GHL returns Instagram media from this host. Unconfirmed
    // by GHL, so the entry is deliberately narrow — the asset subtree is
    // trusted, the apex and its email/marketing hosts are not.
    const r = await downloadMedia(
      "https://static-assets.internal.usercontent.site/ig/asset.mp4",
      { fetchImpl: ok(new Uint8Array(4)), lookupImpl: publicLookup }
    );
    expect("bytes" in r && r.bytes.length).toBe(4);
    for (const blocked of [
      "https://usercontent.site/x",
      "https://email.email.usercontent.site/x",
      "https://internal.usercontent.site.evil.example.com/x",
    ]) {
      const b = await downloadMedia(blocked, { fetchImpl: ok(new Uint8Array(1)), lookupImpl: publicLookup });
      expect(b, blocked).toEqual({ error: "disallowed_host" });
    }
  });
  it("refuses a trusted NAME that resolves inward — the backstop for a wrongly-trusted host", async () => {
    // The allowlist trusts whole domains including subdomains, so it cannot see
    // where a name points. Cloud metadata, loopback and the private ranges must
    // be unreachable even from an allowlisted host.
    for (const addr of [
      "169.254.169.254", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    ]) {
      let fetched = false;
      const spy = (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch;
      const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
        fetchImpl: spy, lookupImpl: async () => [{ address: addr, family: 4 }],
      });
      expect(r, addr).toEqual({ error: "private_address" });
      expect(fetched, addr).toBe(false);
    }
    // IPv6 loopback/link-local/ULA, and the IPv4-mapped form of metadata.
    for (const [addr, family] of [["::1", 6], ["fe80::1", 6], ["fd00::1", 6], ["::ffff:169.254.169.254", 6]] as const) {
      const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
        fetchImpl: ok(new Uint8Array(1)), lookupImpl: async () => [{ address: addr, family }],
      });
      expect(r, addr).toEqual({ error: "private_address" });
    }
    // One private address among several is still a refusal — no cherry-picking.
    const mixed = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
      fetchImpl: ok(new Uint8Array(1)),
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }],
    });
    expect(mixed).toEqual({ error: "private_address" });
    // A host that resolves to nothing is refused rather than handed to fetch.
    const empty = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
      fetchImpl: ok(new Uint8Array(1)), lookupImpl: async () => [],
    });
    expect(empty).toEqual({ error: "private_address" });
  });
  it("rejects non-http(s) schemes before resolving anything", async () => {
    const r = await downloadMedia("file:///etc/passwd", { fetchImpl: ok(new Uint8Array(1)), lookupImpl: publicLookup });
    expect(r).toEqual({ error: "disallowed_host" });
  });
  it("downloads from GHL CDN and enforces cap", async () => {
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: ok(new Uint8Array(10)), lookupImpl: publicLookup });
    expect("bytes" in r && r.bytes.length).toBe(10);
    const big = await downloadMedia("https://storage.msgsndr.com/x.ogg", {
      fetchImpl: ok(new Uint8Array(50)), maxBytes: 40, lookupImpl: publicLookup,
    });
    expect(big).toEqual({ error: "too_large" });
  });
  it("does not follow redirects — 3xx from an allowed host fails closed", async () => {
    let redirectMode: string | undefined;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x" } });
    }) as unknown as typeof fetch;
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: impl, lookupImpl: publicLookup });
    expect(r).toEqual({ error: "fetch_failed" });
    expect(redirectMode).toBe("manual");
  });
  it("rejects oversize via content-length pre-check", async () => {
    // Body is tiny (under the cap) — only the content-length pre-check can
    // produce too_large here; the streaming cap alone would return bytes.
    const impl = (async () =>
      new Response(new Uint8Array(10), { status: 200, headers: { "content-length": "999999999" } })
    ) as unknown as typeof fetch;
    const r = await downloadMedia("https://storage.msgsndr.com/x.ogg", { fetchImpl: impl, maxBytes: 100, lookupImpl: publicLookup });
    expect(r).toEqual({ error: "too_large" });
  });
});
