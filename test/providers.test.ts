import { describe, expect, it } from "vitest";
import { getProvider } from "../src/providers";

const capture = (body: unknown) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
};

describe("gemini adapter", () => {
  it("sends inline_data and joins candidate text", async () => {
    const { impl, calls } = capture({
      candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }],
    });
    const p = getProvider("gemini", "GK", impl);
    const out = await p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1, 2]) });
    expect(out).toBe("hello world");
    expect(calls[0].url).toContain(":generateContent");
    expect(calls[0].url).not.toContain("GK");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("GK");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("audio/ogg");
  });
});

describe("openai adapter", () => {
  it("routes audio to whisper transcriptions", async () => {
    const { impl, calls } = capture({ text: "the transcript" });
    const p = getProvider("openai", "OK", impl);
    const out = await p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) });
    expect(out).toBe("the transcript");
    expect(calls[0].url).toContain("/v1/audio/transcriptions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer OK");
  });
  it("routes image to chat completions with a data URL", async () => {
    const { impl, calls } = capture({ choices: [{ message: { content: "a receipt" } }] });
    const p = getProvider("openai", "OK", impl);
    const out = await p.describe({ kind: "image", mime: "image/png", bytes: new Uint8Array([9]) });
    expect(out).toBe("a receipt");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
  it("pdf returns the unsupported notice", async () => {
    const p = getProvider("openai", "OK", capture({}).impl);
    const out = await p.describe({ kind: "pdf", mime: "application/pdf", bytes: new Uint8Array([1]) });
    expect(out).toContain("not yet supported");
  });
});

describe("error handling", () => {
  it("gemini throws on empty candidates", async () => {
    const { impl } = capture({ candidates: [] });
    const p = getProvider("gemini", "GK", impl);
    await expect(p.describe({ kind: "image", mime: "image/png", bytes: new Uint8Array([1]) }))
      .rejects.toThrow(/no text/);
  });
  it("gemini http error carries only the status, never the url/key", async () => {
    const impl = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const p = getProvider("gemini", "SECRETKEY", impl);
    await expect(p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) }))
      .rejects.toThrow(/^gemini 403$/);
  });
  it("gemini network error is redacted", async () => {
    const impl = (async () => { throw new Error("connect fail https://g/?key=SECRETKEY"); }) as unknown as typeof fetch;
    const p = getProvider("gemini", "SECRETKEY", impl);
    await expect(p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) }))
      .rejects.toThrow(/^gemini request failed \(network\)$/);
  });
  it("whisper whitespace-only transcript throws", async () => {
    const { impl } = capture({ text: "   " });
    const p = getProvider("openai", "OK", impl);
    await expect(p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) }))
      .rejects.toThrow(/no text/);
  });
  it("whisper filename extension follows the mime type", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const impl = (async (_u: unknown, init: RequestInit = {}) => {
      calls.push({ init });
      return new Response(JSON.stringify({ text: "t" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = getProvider("openai", "OK", impl);
    await p.describe({ kind: "audio", mime: "audio/wav", bytes: new Uint8Array([1]) });
    const form = calls[0].init.body as FormData;
    expect((form.get("file") as File).name).toBe("audio.wav");
  });
  it("gemini validateKey hits the models list with a header key, not generateContent", async () => {
    const { impl, calls } = capture({ models: [] });
    const p = getProvider("gemini", "GK", impl);
    expect(await p.validateKey()).toEqual({ ok: true });
    expect(calls[0].url).toContain("/v1beta/models");
    expect(calls[0].url).not.toContain("generateContent");
    expect(calls[0].url).not.toContain("GK");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("GK");
  });
  it("gemini validateKey surfaces Google's error status and message", async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }),
        { status: 400 },
      )) as unknown as typeof fetch;
    const p = getProvider("gemini", "GK", impl);
    const r = await p.validateKey();
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("HTTP 400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.");
  });
  it("validateKey reflects provider reachability", async () => {
    const gBad = getProvider("gemini", "GK", (async () => { throw new Error("x"); }) as unknown as typeof fetch);
    expect((await gBad.validateKey()).ok).toBe(false);
    const oOk = getProvider("openai", "OK", (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    expect(await oOk.validateKey()).toEqual({ ok: true });
    const oBad = getProvider("openai", "OK",
      (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 })) as unknown as typeof fetch);
    const r = await oBad.validateKey();
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("HTTP 401: Incorrect API key provided");
  });
});
