import { type MediaInput, type MediaProvider, PROMPTS, toBase64 } from "./types";

const BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export function geminiProvider(apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  const f = fetchImpl ?? fetch;
  const generate = async (parts: unknown[]) => {
    const res = await f(`${BASE}/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "").join("");
    if (!text.trim()) throw new Error("gemini returned no text");
    return text;
  };
  return {
    describe: (input: MediaInput) =>
      generate([
        { inline_data: { mime_type: input.mime, data: toBase64(input.bytes) } },
        { text: PROMPTS[input.kind] },
      ]),
    async validateKey() {
      try { await generate([{ text: "Reply with the single word: ok" }]); return true; }
      catch { return false; }
    },
  };
}
