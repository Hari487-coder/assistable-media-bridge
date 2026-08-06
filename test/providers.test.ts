import { describe, expect, it } from "vitest";
import { getProvider } from "../src/providers";
import { PROMPTS, buildPrompt } from "../src/providers/types";

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
  it("self-heals a retired model: 404 → discover via /models → retry → cache", async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes(":generateContent")) {
        if (String(url).includes("gemini-flash-latest")) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "healed" }] } }],
        }), { status: 200 });
      }
      // /models discovery listing
      return new Response(JSON.stringify({ models: [
        { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4-flash-preview", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = getProvider("gemini", "HEAL_KEY_1", impl);
    const out = await p.describe({ kind: "image", mime: "image/jpeg", bytes: new Uint8Array([1]) });
    expect(out).toBe("healed");
    // Sequence: default model 404 → /models → stable newest flash (not -lite is
    // not required, but preview/exp must lose to stable; 3.5-flash sorts last).
    expect(calls[0]).toContain("gemini-flash-latest:generateContent");
    expect(calls[1]).toContain("/v1beta/models?");
    expect(calls[2]).toContain("gemini-3.5-flash:generateContent");
    // Cached: a second call goes straight to the resolved model, no rediscovery.
    await p.describe({ kind: "image", mime: "image/jpeg", bytes: new Uint8Array([1]) });
    expect(calls[3]).toContain("gemini-3.5-flash:generateContent");
    expect(calls).toHaveLength(4);
  });
  it("a 404 with no flash model available surfaces the original error", async () => {
    const impl = (async (url: string) => {
      if (String(url).includes(":generateContent")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = getProvider("gemini", "HEAL_KEY_2", impl);
    await expect(p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) }))
      .rejects.toThrow(/^gemini 404$/);
  });
  it("non-404 provider errors do not trigger model discovery", async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 429 });
    }) as unknown as typeof fetch;
    const p = getProvider("gemini", "HEAL_KEY_3", impl);
    await expect(p.describe({ kind: "audio", mime: "audio/ogg", bytes: new Uint8Array([1]) }))
      .rejects.toThrow(/^gemini 429$/);
    expect(calls).toHaveLength(1);
  });
  it("sends video as inline_data with the watch-and-transcribe prompt", async () => {
    const { impl, calls } = capture({
      candidates: [{ content: { parts: [{ text: "a person on a scale; they say: fünf Kilo abnehmen" }] } }],
    });
    const p = getProvider("gemini", "GK", impl);
    const out = await p.describe({ kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
    expect(out).toContain("fünf Kilo");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("video/mp4");
    expect(body.contents[0].parts[1].text).toMatch(/video shows/);
    expect(body.contents[0].parts[1].text).toMatch(/never translate/);
  });
  it("the audio prompt pins the transcript to the spoken language", () => {
    // A German voice note must reach the assistant as German — the assistant
    // replies in whatever language the transcript arrives in.
    expect(PROMPTS.audio).toMatch(/language it was spoken/);
    expect(PROMPTS.audio).toMatch(/never translate/);
  });
  it("sends images as inline_data with the OCR prompt", async () => {
    const { impl, calls } = capture({
      candidates: [{ content: { parts: [{ text: "a red card on a wooden table" }] } }],
    });
    const p = getProvider("gemini", "GK", impl);
    const out = await p.describe({ kind: "image", mime: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) });
    expect(out).toBe("a red card on a wooden table");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("image/jpeg");
    expect(body.contents[0].parts[1].text).toMatch(/OCR/);
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
  it("video returns an honest notice instead of guessing", async () => {
    const { impl, calls } = capture({});
    const p = getProvider("openai", "OK", impl);
    const out = await p.describe({ kind: "video", mime: "video/mp4", bytes: new Uint8Array([1]) });
    expect(out).toContain("video reading is not supported on the OpenAI provider");
    expect(calls).toHaveLength(0); // no API spend on a kind it cannot handle
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

describe("per-tenant analysis instruction", () => {
  it("appends the instruction without replacing the built-in extraction prompt", () => {
    const base = buildPrompt("image");
    const withExtra = buildPrompt("image", "Extract the amount and reference number.");
    expect(base).toBe(PROMPTS.image);
    // The base task stays anchored — an instruction that replaced it would
    // silently drop OCR from every other conversation.
    expect(withExtra.startsWith(PROMPTS.image)).toBe(true);
    expect(withExtra).toContain("Extract the amount and reference number.");
  });
  it("ignores a blank or whitespace-only instruction", () => {
    expect(buildPrompt("audio", "")).toBe(PROMPTS.audio);
    expect(buildPrompt("audio", "   \n ")).toBe(PROMPTS.audio);
    expect(buildPrompt("audio", null)).toBe(PROMPTS.audio);
  });
  it("reaches the gemini request body", async () => {
    const { impl, calls } = capture({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await getProvider("gemini", "GK", impl).describe({
      kind: "image", mime: "image/png", bytes: new Uint8Array([1]),
      instruction: "Note the transaction id.",
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.contents[0].parts[1].text).toContain("Note the transaction id.");
    expect(body.contents[0].parts[1].text).toContain("OCR");
  });
  it("reaches the openai vision request body", async () => {
    const { impl, calls } = capture({ choices: [{ message: { content: "ok" } }] });
    await getProvider("openai", "OK", impl).describe({
      kind: "image", mime: "image/png", bytes: new Uint8Array([1]),
      instruction: "Note the transaction id.",
    });
    const body = JSON.parse(String(calls[0].init.body));
    const textPart = body.messages[0].content.find((c: { type: string }) => c.type === "text");
    expect(textPart.text).toContain("Note the transaction id.");
    expect(textPart.text).toContain("OCR");
  });
});
