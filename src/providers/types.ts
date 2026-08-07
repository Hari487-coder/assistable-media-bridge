export interface MediaInput {
  kind: "audio" | "image" | "video" | "pdf"; mime: string; bytes: Uint8Array;
  /** Optional per-tenant guidance appended to the built-in prompt. */
  instruction?: string | null;
}
export interface KeyCheck { ok: boolean; detail?: string }
export interface MediaProvider {
  describe(input: MediaInput): Promise<string>;
  validateKey(): Promise<KeyCheck>;
}
// "in the language it was spoken" is load-bearing: a tester's German voice
// note must reach the assistant as German, not as the model's helpful English
// translation — the assistant replies in whatever language the transcript is.
export const PROMPTS = {
  audio: "Transcribe this voice message verbatim, in the language it was spoken — never translate it. Reply with ONLY the transcript text.",
  image: "Describe this image for a customer-support agent. Extract ALL visible text verbatim (OCR), then add a one-sentence description of what the image shows.",
  video: "This is a video sent by a customer. Describe for a customer-support agent what the video shows, then transcribe any speech verbatim, in the language it was spoken — never translate it. If there is nothing meaningful to see (audio-only or a static frame), skip the description and reply as if it were a voice message: ONLY the verbatim transcript.",
  pdf: "Extract the full text of this document, then summarize it in 2 sentences.",
} as const;

/**
 * Compose the prompt actually sent to the vision/speech model.
 *
 * The built-in prompt goes FIRST and the tenant's instruction is appended as
 * additional focus, never as a replacement. Generic OCR reliably captures the
 * headline number on a receipt and routinely garbles the small print — a
 * reference id, a last-4, a bank name — so naming those fields materially
 * improves extraction. But the base task has to stay anchored: an instruction
 * that quietly replaced it would turn "read this attachment" into whatever the
 * tenant last typed, and every other conversation would silently lose its OCR.
 *
 * Extraction only. Nothing here decides anything — see the note in the README
 * about not using this as a payment approval gate.
 */
export function buildPrompt(kind: MediaInput["kind"], instruction?: string | null): string {
  const extra = (instruction ?? "").trim();
  return extra ? `${PROMPTS[kind]}\n\nAdditionally, pay attention to the following and include it in your answer if present: ${extra}` : PROMPTS[kind];
}

export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
