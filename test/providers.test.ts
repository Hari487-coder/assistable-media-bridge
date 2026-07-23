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
    expect(calls[0].url).toContain(":generateContent?key=GK");
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
