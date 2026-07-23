import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import type { MediaProvider } from "./types";

export type ProviderName = "gemini" | "openai";
export function getProvider(name: ProviderName, apiKey: string, fetchImpl?: typeof fetch): MediaProvider {
  return name === "gemini" ? geminiProvider(apiKey, fetchImpl) : openaiProvider(apiKey, fetchImpl);
}
export type { MediaProvider } from "./types";
