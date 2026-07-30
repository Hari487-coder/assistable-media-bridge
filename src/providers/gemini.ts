import { type MediaInput, type MediaProvider, buildPrompt, toBase64 } from "./types";

const BASE = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";
// Rolling alias, not a pinned version: Google retires pinned Gemini models on
// short notice (gemini-2.5-flash 404'd live on 2026-07-30 before its published
// shutdown date) and onboarding deliberately validates the KEY, not the model.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

// Per-key model resolution cache: once a 404 forces discovery, remember what
// worked so every later call skips the extra round-trip. In-process only.
const resolvedByKey = new Map<string, string>();

export function geminiProvider(apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  const f = fetchImpl ?? fetch;
  const generate = async (parts: unknown[], model: string) => {
    let res: Response;
    try {
      // Key travels in a header, never the URL — URLs end up in logs and proxies.
      res = await f(`${BASE}/v1beta/models/${model}:generateContent`, {
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

  // Ask the key's own /models list which flash-class model it can actually
  // use. Deterministic pick: generateContent-capable flash models, stable
  // (non-preview/exp) preferred, newest name first.
  const discoverFlashModel = async (): Promise<string | null> => {
    let res: Response;
    try {
      res = await f(`${BASE}/v1beta/models?pageSize=100`, {
        headers: { "x-goog-api-key": apiKey },
      });
    } catch { return null; }
    if (!res.ok) return null;
    const json = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const candidates = (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((n) => n.includes("flash"));
    if (candidates.length === 0) return null;
    const stable = candidates.filter((n) => !/preview|exp/.test(n));
    return (stable.length ? stable : candidates).sort().reverse()[0];
  };

  return {
    describe: async (input: MediaInput) => {
      const parts = [
        { inline_data: { mime_type: input.mime, data: toBase64(input.bytes) } },
        { text: buildPrompt(input.kind, input.instruction) },
      ];
      const model = resolvedByKey.get(apiKey) ?? MODEL;
      try {
        return await generate(parts, model);
      } catch (err) {
        // Self-heal ONLY the model-retired case — a 404 on generateContent.
        // Everything else (quota, auth, network) propagates untouched.
        if (!(err instanceof Error && err.message === "gemini 404")) throw err;
        const fallback = await discoverFlashModel();
        if (!fallback || fallback === model) throw err;
        const out = await generate(parts, fallback);
        resolvedByKey.set(apiKey, fallback);
        return out;
      }
    },
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
