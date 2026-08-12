import { type LookupFn, defaultLookup, isPrivateAddress } from "../media/download";

export type AssetKind = "image" | "video" | "audio" | "document";

/** Content types GHL will carry as an attachment, grouped by how we label them
 *  to the model. Anything outside this set is refused at registration — better
 *  a clear error in the portal than a broken bubble in front of a lead. */
const DOCUMENT_TYPES = new Set([
  "application/pdf", "application/msword", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
]);

const EXT_KIND: Record<string, AssetKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  svg: "image", heic: "image",
  mp4: "video", mov: "video", mpeg: "video", mpg: "video", "3gp": "video",
  mp3: "audio", ogg: "audio", m4a: "audio", wav: "audio", aac: "audio",
  amr: "audio",
  pdf: "document", doc: "document", docx: "document", txt: "document",
  csv: "document", xls: "document", xlsx: "document", ppt: "document",
  pptx: "document", odt: "document",
};

function kindFromContentType(raw: string | null): AssetKind | null {
  if (!raw) return null;
  const ct = raw.split(";")[0].trim().toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  return DOCUMENT_TYPES.has(ct) ? "document" : null;
}

function kindFromExtension(url: string): AssetKind | null {
  const path = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? null;
}

/**
 * Slug an asset name into the exact token the model has to quote back.
 *
 * The model reads these names out of the tool description and repeats one in
 * its tool call, so the form has to be stable and unambiguous — no spaces to
 * mis-quote, no casing to get wrong. Returns "" when nothing survives, which
 * callers treat as an invalid name.
 */
export function normalizeAssetName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export type AssetUrlCheck =
  | { ok: true; kind: AssetKind }
  | { ok: false; error: string };

/**
 * Validate an asset URL at registration time.
 *
 * Registration is the only moment we can fail loudly: at send time the URL is
 * handed to GHL and a bad one becomes a broken message in a real conversation.
 * The private-address check matters even though WE never fetch the bytes —
 * without it a tenant could register an internal URL and have GHL fetch it.
 */
export async function validateAssetUrl(
  url: string,
  opts: { fetchImpl?: typeof fetch; lookupImpl?: LookupFn } = {}
): Promise<AssetUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "that does not look like a URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "the URL must start with http:// or https://" };
  }

  // An IP literal must never be handed to the resolver: there is nothing to
  // resolve, and trusting a lookup to echo it back is how http://169.254.169.254
  // slips through. Classify it directly.
  const literal = parseIpLiteral(parsed.hostname);
  if (literal) {
    return isPrivateAddress(literal.address, literal.family)
      ? { ok: false, error: `${parsed.hostname} is a private address` }
      : await probe(url, opts);
  }

  const lookup = opts.lookupImpl ?? defaultLookup;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (lookup as LookupFn)(parsed.hostname);
  } catch {
    return { ok: false, error: `${parsed.hostname} could not be reached (DNS)` };
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address, a.family))) {
    return { ok: false, error: `${parsed.hostname} resolves to a private address` };
  }

  return await probe(url, opts);
}

/** Parse a bare IPv4/IPv6 host. Returns null for real hostnames. */
function parseIpLiteral(host: string): { address: string; family: number } | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return { address: bare, family: 4 };
  if (bare.includes(":")) return { address: bare, family: 6 };
  return null;
}

async function probe(
  url: string,
  opts: { fetchImpl?: typeof fetch; lookupImpl?: LookupFn }
): Promise<AssetUrlCheck> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { method: "HEAD", redirect: "follow" });
  } catch {
    return { ok: false, error: "the URL could not be reached" };
  }
  if (!res.ok) {
    return { ok: false, error: `the URL could not be reached (HTTP ${res.status})` };
  }
  const kind = kindFromContentType(res.headers.get("content-type")) ?? kindFromExtension(url);
  if (!kind) {
    return {
      ok: false,
      error: "that file type cannot be sent as a message attachment — use an image, video, audio or document",
    };
  }
  return { ok: true, kind };
}
