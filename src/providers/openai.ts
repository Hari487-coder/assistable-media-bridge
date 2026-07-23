import { type MediaInput, type MediaProvider, PROMPTS, toBase64 } from "./types";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const AUDIO_EXT: Record<string, string> = {
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  "audio/wav": "wav", "audio/amr": "amr",
};

export function openaiProvider(apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  const f = fetchImpl ?? fetch;
  return {
    async describe(input: MediaInput) {
      if (input.kind === "pdf") return "[PDF reading is not yet supported on the OpenAI provider]";
      if (input.kind === "audio") {
        const form = new FormData();
        form.set("model", "whisper-1");
        const ext = AUDIO_EXT[input.mime] ?? "ogg";
        form.set("file", new Blob([Buffer.from(input.bytes)], { type: input.mime }), `audio.${ext}`);
        const res = await f(`${BASE}/v1/audio/transcriptions`, {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
        });
        if (!res.ok) throw new Error(`openai whisper ${res.status}`);
        const json = (await res.json()) as { text?: string };
        if (!json.text?.trim()) throw new Error("openai whisper returned no text");
        return json.text;
      }
      const res = await f(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: `data:${input.mime};base64,${toBase64(input.bytes)}` } },
            { type: "text", text: PROMPTS.image },
          ] }],
        }),
      });
      if (!res.ok) throw new Error(`openai vision ${res.status}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("openai vision returned no text");
      return text;
    },
    async validateKey() {
      try {
        const res = await f(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
        return res.ok;
      } catch { return false; }
    },
  };
}
