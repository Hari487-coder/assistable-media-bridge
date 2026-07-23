export interface MediaInput { kind: "audio" | "image" | "pdf"; mime: string; bytes: Uint8Array }
export interface MediaProvider {
  describe(input: MediaInput): Promise<string>;
  validateKey(): Promise<boolean>;
}
export const PROMPTS = {
  audio: "Transcribe this voice message verbatim. Reply with ONLY the transcript text.",
  image: "Describe this image for a customer-support agent. Extract ALL visible text verbatim (OCR), then add a one-sentence description of what the image shows.",
  pdf: "Extract the full text of this document, then summarize it in 2 sentences.",
} as const;
export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
