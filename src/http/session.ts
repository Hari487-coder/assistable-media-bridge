import type { Request, Response } from "express";

/**
 * Remembers which dashboards this browser has connected.
 *
 * The dashboard token IS the credential — there is no login — so it only ever
 * existed in the URL. Close the tab and the operator had no way back to their
 * own dashboard, landed on the setup form, and re-entered every credential to
 * get there. (Nothing was actually lost: re-onboarding a location reconnects
 * the same tenant in place. It just looked like total loss, which is worse.)
 *
 * A cookie is strictly safer than the URL it replaces: httpOnly puts it out of
 * reach of page scripts, and it stops the token being copied around in link
 * history. It never widens access — you can only be reminded of a dashboard
 * this browser already reached.
 */
const COOKIE = "mb_dash";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/** Bounds the cookie: an agency connecting dozens of subaccounts must not
 *  eventually exceed the ~4KB header limit and lose the lot. */
const MAX_REMEMBERED = 25;
const TOKEN_SHAPE = /^[a-f0-9]{48}$/;

export function rememberedTokens(req: Request): string[] {
  const header = req.headers.cookie;
  if (!header) return [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    // res.cookie percent-encodes the value, so the "," separator comes back as
    // %2C. Without decoding, one remembered dashboard parses fine and two parse
    // as nothing — an agency silently loses every link but the newest.
    const raw = part.slice(eq + 1).trim();
    const value = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
    return value.split(",")
      .map((t) => t.trim())
      .filter((t) => TOKEN_SHAPE.test(t))
      .slice(0, MAX_REMEMBERED);
  }
  return [];
}

/** Newest first, deduped, so the most recently connected subaccount leads. */
export function rememberToken(req: Request, res: Response, token: string): void {
  if (!TOKEN_SHAPE.test(token)) return;
  const next = [token, ...rememberedTokens(req).filter((t) => t !== token)]
    .slice(0, MAX_REMEMBERED);
  res.cookie(COOKIE, next.join(","), {
    httpOnly: true,
    sameSite: "lax",
    // Only over TLS in production; a local http run must still work.
    secure: req.protocol === "https" || req.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: ONE_YEAR_MS,
  });
}

export function forgetTokens(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}
