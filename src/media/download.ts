const ALLOWED_SUFFIXES = ["leadconnectorhq.com", "msgsndr.com", "assistable.ai"];
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export type DownloadResult =
  | { bytes: Uint8Array }
  | { error: "disallowed_host" | "too_large" | "fetch_failed" };

export async function downloadMedia(
  url: string,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number } = {}
): Promise<DownloadResult> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let host: string;
  try { host = new URL(url).hostname; } catch { return { error: "fetch_failed" }; }
  if (!ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return { error: "disallowed_host" };
  }
  try {
    const res = await f(url);
    if (!res.ok) return { error: "fetch_failed" };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) return { error: "too_large" };
    return { bytes: buf };
  } catch { return { error: "fetch_failed" }; }
}
