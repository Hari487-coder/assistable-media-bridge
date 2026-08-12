import { lookup as dnsLookup } from "node:dns/promises";

// One entry per channel whose media GHL does NOT rehost itself, added as each
// channel goes live: GCS for SMS/MMS (2026-07-30), Meta's CDN for Instagram
// and Messenger (2026-08-07 — an Instagram voice note failed disallowed_host
// with the whole rest of the pipeline working). Allowing public object storage
// does not weaken the SSRF posture: the allowlist exists to stop fetches into
// private/internal endpoints, and attachment URLs come from GHL's own message
// records, not from contact-controlled text.
//
// A missing entry is a SILENT channel outage, so the failure note names the
// blocked host (see analyze.ts). That name is a LEAD, NOT AN INSTRUCTION:
// attachment URLs ride in on inbound messages, so a blocked host is as likely
// to be an attacker's as a channel's. Attribute a host before adding it, and
// keep the entry as narrow as the evidence — the private-address check below
// is the backstop that keeps a wrong judgement from reaching the local
// network, but it cannot tell you whose CDN you just trusted.
const ALLOWED_SUFFIXES = [
  "leadconnectorhq.com",
  "msgsndr.com",
  "assistable.ai",
  "storage.googleapis.com",
  // Meta — Instagram DMs and Facebook Messenger.
  "cdninstagram.com",
  "fbcdn.net",
  "fbsbx.com",
  // The host GHL returns for Instagram media (live 2026-08-07). UNCONFIRMED by
  // GHL docs or support, and its certificates are domain-validated with no
  // organization, so this entry is a judgement call, recorded here honestly.
  //
  // What argues real infrastructure over an attacker's throwaway: certificate
  // transparency shows this domain issuing since 2023-03 across four CAs, with
  // a production AND staging pair of every asset host (static-assets,
  // static-invoice-assets, email) — nobody maintains a staging environment for
  // three years to land an SSRF. Scoped to the `internal.` subtree rather than
  // the apex, so the email/marketing hosts on this domain stay blocked.
  //
  // Confirm with GHL support, then tighten to the exact host or drop it. The
  // bytes fetched here are contact-supplied either way and are treated as
  // untrusted content, exactly like every other attachment.
  "internal.usercontent.site",
];
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Injectable so unit tests never touch real DNS. */
export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

export type DownloadResult =
  | { bytes: Uint8Array }
  | { error: "disallowed_host" | "private_address" | "too_large" | "fetch_failed" };

function allowedHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // http(s) only — file:, gopher: and friends are not attachment transports.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname;
  const ok = ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  return ok ? host : null;
}

/**
 * Is this address somewhere we must never fetch from?
 *
 * The name allowlist trusts whole domains including their subdomains, so it
 * cannot see where a name actually points. This is the check that does: if a
 * trusted domain ever resolves inward — a stray internal DNS record, a
 * subdomain takeover, a rebinding attack, or simply a host added on weaker
 * evidence than it deserved — the fetch stops here instead of reaching the
 * loopback interface, the private network, or a cloud metadata endpoint.
 *
 * Unparseable input returns true: refuse what we cannot classify.
 */
export function isPrivateAddress(ip: string, family: number): boolean {
  if (family === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;                          // 0.0.0.0/8, "this network"
    if (a === 10) return true;                         // 10/8 private
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local — incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 private
    if (a === 192 && b === 168) return true;           // 192.168/16 private
    if (a === 192 && b === 0) return true;             // 192.0.0/24 IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true;                         // multicast, reserved, broadcast
    return false;
  }
  const v6 = ip.toLowerCase().split("%")[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1], 4);   // IPv4-mapped, e.g. ::ffff:169.254.169.254
  if (v6 === "::" || v6 === "::1") return true;        // unspecified, loopback
  if (/^fe[89ab]/.test(v6)) return true;               // fe80::/10 link-local
  if (/^f[cd]/.test(v6)) return true;                  // fc00::/7 unique local
  return false;
}

export const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

export async function downloadMedia(
  url: string,
  opts: { fetchImpl?: typeof fetch; maxBytes?: number; lookupImpl?: LookupFn } = {}
): Promise<DownloadResult> {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const host = allowedHost(url);
  if (host === null) {
    return { error: "disallowed_host" };
  }
  // Second gate: WHERE the trusted name actually points. Deliberately narrow —
  // a residual TOCTOU remains because fetch resolves the name again itself, so
  // a sub-second rebind could still slip through. Closing that needs pinning
  // the connection to the address checked here, which Node's fetch cannot do
  // without a custom dispatcher; the name allowlist plus this check is the
  // proportionate defence for attachment URLs that arrive over a channel.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (opts.lookupImpl ?? defaultLookup)(host);
  } catch {
    return { error: "fetch_failed" };
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address, a.family))) {
    return { error: "private_address" };
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
