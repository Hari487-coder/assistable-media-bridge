// One entry per channel whose media GHL does NOT rehost itself, added as each
// channel goes live: GCS for SMS/MMS (2026-07-30), Meta's CDN for Instagram
// and Messenger (2026-08-07 — an Instagram voice note failed disallowed_host
// with the whole rest of the pipeline working). Allowing public object storage
// does not weaken the SSRF posture: the allowlist exists to stop fetches into
// private/internal endpoints, and attachment URLs come from GHL's own message
// records, not from contact-controlled text.
//
// A missing entry is a SILENT channel outage, so the failure note names the
// blocked host (see analyze.ts). That name is a LEAD, NOT AN INSTRUCTION.
// Attachment URLs ride in on inbound messages, so a blocked host is just as
// likely to be an attacker's as a channel's, and this list is the only thing
// standing between an inbound message and a fetch from our server. Live on
// 2026-08-07 the blocked host was `static-assets.internal.usercontent.site`:
// a cheap-TLD domain, Cloudflare-fronted, domain-validated cert with no
// organization, named to read as internal infrastructure, and matching
// nothing in the Assistable or GHL estate. It was NOT added.
//
// Add a host only after attributing it to the channel operator through their
// own documentation or support — never because it appeared in a trace.
const ALLOWED_SUFFIXES = [
  "leadconnectorhq.com",
  "msgsndr.com",
  "assistable.ai",
  "storage.googleapis.com",
  // Meta — Instagram DMs and Facebook Messenger.
  "cdninstagram.com",
  "fbcdn.net",
  "fbsbx.com",
];
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export type DownloadResult =
  | { bytes: Uint8Array }
  | { error: "disallowed_host" | "too_large" | "fetch_failed" };

function hostAllowed(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export async function downloadMedia(
  url: string,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number } = {}
): Promise<DownloadResult> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!hostAllowed(url)) {
    return { error: "disallowed_host" };
  }
  try {
    // redirect: "manual" — a 3xx from an allowed host must NOT be followed
    // blindly (SSRF: Location can point anywhere). Treated as failure; if
    // the live spike shows the GHL CDN uses redirects, add allowlist-checked
    // hop following instead.
    const res = await f(url, { redirect: "manual" });
    if (!res.ok) {
      return { error: "fetch_failed" };
    }
    // Content-Length pre-check: reject an honestly-declared oversize body
    // before reading a single byte.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > max) {
      return { error: "too_large" };
    }
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.length > max ? { error: "too_large" } : { bytes: buf };
    }
    // Stream with early abort so an oversized (or lying) response never
    // fully buffers into memory.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > max) {
        await reader.cancel();
        return { error: "too_large" };
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    return { bytes: buf };
  } catch {
    return { error: "fetch_failed" };
  }
}
