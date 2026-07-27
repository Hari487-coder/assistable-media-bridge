import { type MediaInput, type MediaProvider, PROMPTS, toBase64 } from "./types";

const BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

export function geminiProvider(apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  const f = fetchImpl ?? fetch;
  const generate = async (parts: unknown[]) => {
    let res: Response;
    try {
      // Key travels in a header, never the URL — URLs end up in logs and proxies.
      res = await f(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ parts }] }),
      });
    } catch {
      // Never propagate the raw error — it may embed request details.
      throw new Error("gemini request failed (network)");
    }
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
      // Key-only check against the models list — independent of any specific
      // model name (a retired GEMINI_MODEL must not fail key validation) and
      // free of generation quota. Mirrors the OpenAI provider's approach.
      let res: Response;
      try {
        res = await f(`${BASE}/v1beta/models?pageSize=1`, {
          headers: { "x-goog-api-key": apiKey },
        });
      } catch {
        return { ok: false, detail: "could not reach the Gemini API (network)" };
      }
      if (res.ok) return { ok: true };
      let detail = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { error?: { status?: string; message?: string } };
        const status = err.error?.status;
        const message = err.error?.message?.slice(0, 200);
        if (status) detail += ` ${status}`;
        if (message) detail += `: ${message}`;
      } catch { /* non-JSON error body — status alone is still useful */ }
      return { ok: false, detail };
    },
  };
}
