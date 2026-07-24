import express from "express";
import { createGhlClient } from "./clients/ghl";
import { createV3Client } from "./clients/v3";
import { WAKE_INSTRUCTION } from "./core/waker";
import { downloadMedia } from "./media/download";
import { sniff } from "./media/sniff";

const [cmd, arg] = process.argv.slice(2);
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
  return v;
};
const v3 = () => createV3Client({
  baseUrl: process.env.V3_BASE_URL ?? "https://api.assistable.ai",
  apiKey: env("SPIKE_V3_KEY"),
});
const ghl = () => createGhlClient({
  baseUrl: process.env.GHL_BASE_URL ?? "https://services.leadconnectorhq.com",
  pit: env("SPIKE_GHL_PIT"),
});

async function main() {
  if (cmd === "detect") {
    console.log("Polling for media-signature messages for 2 minutes — send the voice note NOW.");
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const convs = await v3().listConversations(10);
      for (const c of convs) {
        const msgs = await v3().listMessages(c.id);
        for (const m of msgs) {
          if (m.source === "USER" && !m.ai && (!m.content || !m.content.trim()) && !seen.has(m.id)) {
            seen.add(m.id);
            console.log(`${new Date().toISOString()} DETECTED conv=${c.id} msg=${m.id} channel=${m.channel} createdAt=${m.createdAt}`);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else if (cmd === "fetch") {
    const rows = await ghl().latestMediaMessages({
      locationId: env("SPIKE_LOCATION_ID"), contactId: arg ?? env("SPIKE_CONTACT_ID"),
    });
    console.log(JSON.stringify(rows, null, 2));
    for (const r of rows) for (const url of r.attachments) {
      const dl = await downloadMedia(url);
      console.log("error" in dl
        ? `DOWNLOAD FAILED ${url}: ${dl.error}`
        : `OK ${url} → ${dl.bytes.length} bytes, sniffed ${JSON.stringify(sniff(dl.bytes))}`);
    }
  } else if (cmd === "wake") {
    const r = await v3().chatCompletion({
      assistantId: env("SPIKE_ASSISTANT_ID"), conversationId: arg ?? env("SPIKE_CONVERSATION_ID"),
      additionalInstructions: WAKE_INSTRUCTION,
    });
    console.log(r.ok ? "WAKE SENT — watch the phone for the assistant's reply." : `WAKE FAILED: ${r.error}`);
  } else if (cmd === "tool-listen") {
    const app = express();
    app.use(express.json());
    app.all("*", (req, res) => {
      console.log("--- envelope received ---");
      console.log(JSON.stringify({ path: req.path, body: req.body }, null, 2));
      res.json({ result: "spike listener says hello" });
    });
    app.listen(4001, () => console.log("tool-listen on :4001 — point a test tool at this URL"));
  } else {
    console.log("Usage: npm run spike -- detect | fetch <contactId> | wake <conversationId> | tool-listen");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
