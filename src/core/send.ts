import type { GhlClient } from "../clients/ghl";
import type { Asset, AssetStore } from "../store/assets";
import type { EventStore } from "../store/events";
import type { SendLog } from "../store/send-log";
import type { Tenant } from "../store/tenants";

export interface SendDeps {
  ghl: Pick<GhlClient, "sendMessage" | "latestConversationChannel">;
  assets: AssetStore;
  events: EventStore;
  sendLog: SendLog;
}

/** Three is enough to be helpful and few enough to stay welcome. Media costs
 *  real money per message on SMS and WhatsApp, and repeated media reads as
 *  spam far faster than repeated text. */
export const MAX_PER_CONTACT_24H = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** One agent run can call a tool several times; without this, a single turn
 *  could fire two or three assets at once. */
const COOLDOWN_MS = 60_000;
/** Captions ride on a real message, so they are bounded like one. */
const MAX_CAPTION = 500;

/**
 * The asset list the model chooses from.
 *
 * This is embedded in the tool description because v3 tools carry no parameter
 * schema (clients/v3.ts createTool sends name/description/url only), so the
 * name cannot be constrained to an enum. The description IS the menu, and the
 * unknown-asset error is the recovery path.
 */
export function buildAssetCatalogue(assets: Asset[]): string {
  if (assets.length === 0) {
    return "No assets are configured for this account yet, so there is nothing to send.";
  }
  const lines = assets.map((a) => `- ${a.name} (${a.kind}): ${a.description}`);
  return `Available assets, call with the exact name:\n${lines.join("\n")}`;
}

const note = (body: string) => `[${body}]`;

export async function sendAssetForContact(
  deps: SendDeps,
  tenant: Tenant,
  input: { contactId: string; asset: string; caption?: string }
): Promise<{ text: string }> {
  const library = deps.assets.list(tenant.id);
  if (library.length === 0) {
    return {
      text: note(
        "this account has no assets configured, so there is nothing to send. " +
        "Reply in text and do not mention or promise any attachment."
      ),
    };
  }

  const asset = deps.assets.get(tenant.id, input.asset ?? "");
  if (!asset) {
    // Naming the valid options is the only correction channel available — the
    // model cannot be constrained to an enum, so it has to be told.
    return {
      text: note(
        `you do not have an asset called "${input.asset}". ` +
        `Available assets: ${library.map((a) => a.name).join(", ")}. ` +
        "Call the tool again with one of those exact names, or reply without media."
      ),
    };
  }

  const skip = (reason: string, body: string) => {
    deps.events.record(tenant.id, "media_skip", `${reason}: ${asset.name} → ${input.contactId}`);
    return { text: note(body) };
  };

  if (deps.sendLog.hasSent(tenant.id, input.contactId, asset.name)) {
    return skip(
      "already sent",
      `you already sent "${asset.name}" to this contact earlier — it was not sent again. ` +
      "Refer back to it in your reply instead of resending it."
    );
  }
  if (deps.sendLog.countSince(tenant.id, input.contactId, Date.now() - DAY_MS) >= MAX_PER_CONTACT_24H) {
    return skip(
      "24h limit",
      `media limit reached: this contact has already received ${MAX_PER_CONTACT_24H} media messages ` +
      "in the last 24 hours, so nothing was sent. Continue the conversation in text."
    );
  }
  const last = deps.sendLog.lastSentAt(tenant.id, input.contactId);
  if (last !== null && Date.now() - last < COOLDOWN_MS) {
    return skip(
      "cooldown",
      "you just sent this contact media a moment ago, so nothing was sent. " +
      "Wait until later in the conversation before sending another."
    );
  }

  const caption = (input.caption ?? "").trim().slice(0, MAX_CAPTION);
  const channel = await deps.ghl.latestConversationChannel(tenant.locationId, input.contactId);
  const result = await deps.ghl.sendMessage({
    contactId: input.contactId,
    type: channel,
    attachments: [asset.url],
    ...(caption ? { message: caption } : {}),
  });

  if (!result.ok) {
    deps.events.record(
      tenant.id, "error", `media send failed (${asset.name}, ${channel}): ${result.error}`
    );
    return {
      text: note(
        `could not send "${asset.name}" (${result.error}). The contact did NOT receive it — ` +
        "never claim or imply that you sent it. Continue in text, or offer to follow up."
      ),
    };
  }

  deps.sendLog.record(tenant.id, input.contactId, asset.name, channel);
  deps.events.record(
    tenant.id, "media_send", `${asset.name} (${asset.kind}) on ${channel} → ${input.contactId}`
  );
  return {
    text: note(
      caption
        ? `sent "${asset.name}" (${asset.kind}) on ${channel} with the caption: "${caption}". ` +
          "The contact has already received that line — do not repeat it in your reply; " +
          "continue naturally from there."
        : `sent "${asset.name}" (${asset.kind}) on ${channel} with no caption. ` +
          "Introduce it briefly in your reply."
    ),
  };
}
