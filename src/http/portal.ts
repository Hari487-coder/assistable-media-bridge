import { Router } from "express";
import { PROMPT_SNIPPET, type ProvisionDeps, provisionTenant } from "../core/provision";
import type { EventStore } from "../store/events";

export interface PortalCtx extends ProvisionDeps { events: EventStore }

// ---- shared shell -----------------------------------------------------
// Signature element: the "wire trace" — a thin dotted connector rendered
// between each step of the pipeline (GHL -> Bridge -> Assistable), used on
// the form and success pages to make the plumbing legible at a glance.

const STYLE = `
  :root {
    color-scheme: dark;
    --bg: #0b0f10; --panel: #12181a; --panel-2: #17201f;
    --line: #223030; --line-soft: #1a2323;
    --ink: #e9f2ee; --ink-dim: #9db3ab; --ink-faint: #5f7570;
    --accent: #59d9b3; --accent-dim: #2c5b4c;
    --warn: #e8b34d; --warn-bg: #2a2412;
    --danger: #e8715f; --danger-bg: #2a1712;
    --radius: 10px;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --sans: -apple-system, "Segoe UI", Inter, Roboto, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: var(--sans); font-size: 15px; line-height: 1.5;
  }
  body {
    background-image:
      radial-gradient(circle at 1px 1px, var(--line-soft) 1px, transparent 1px);
    background-size: 24px 24px;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .brand .dot {
    width: 9px; height: 9px; border-radius: 50%; background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .brand span {
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--ink-dim);
  }
  h1 {
    font-size: 26px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 6px;
  }
  .lede { color: var(--ink-dim); margin: 0 0 32px; max-width: 52ch; }
  .trace {
    display: flex; align-items: center; gap: 0; margin: 0 0 32px;
    font-family: var(--mono); font-size: 12px; color: var(--ink-faint);
  }
  .trace .node {
    padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px;
    color: var(--ink-dim); background: var(--panel-2); white-space: nowrap;
  }
  .trace .node.on { color: var(--accent); border-color: var(--accent-dim); }
  .trace .wire {
    flex: 1; height: 1px; min-width: 16px;
    background-image: linear-gradient(to right, var(--line) 50%, transparent 0);
    background-size: 6px 1px;
  }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 28px;
  }
  fieldset { border: 0; padding: 0; margin: 0 0 22px; }
  legend {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--accent); margin-bottom: 12px; padding: 0;
  }
  .field { margin-bottom: 16px; }
  .field:last-child { margin-bottom: 0; }
  label {
    display: block; font-size: 13px; color: var(--ink-dim); margin-bottom: 6px;
  }
  label .hint { color: var(--ink-faint); font-weight: 400; }
  input, select {
    width: 100%; padding: 10px 12px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; color: var(--ink);
    font-size: 14px; font-family: var(--sans); outline: none;
    transition: border-color 0.15s ease;
  }
  input:focus, select:focus, button:focus-visible, a:focus-visible {
    border-color: var(--accent); outline: 2px solid var(--accent-dim); outline-offset: 1px;
  }
  input::placeholder { color: var(--ink-faint); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
  button, .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 11px 20px; border-radius: 7px; border: 1px solid transparent;
    font-size: 14px; font-weight: 600; cursor: pointer; font-family: var(--sans);
    text-decoration: none;
  }
  .btn-primary { background: var(--accent); color: #04211a; width: 100%; margin-top: 6px; }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-ghost {
    background: transparent; border-color: var(--line); color: var(--ink-dim);
  }
  .btn-ghost:hover { border-color: var(--accent-dim); color: var(--ink); }
  .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 0; }
  code, pre {
    font-family: var(--mono); font-size: 13px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; color: var(--accent);
  }
  code { padding: 2px 7px; word-break: break-all; }
  pre {
    padding: 16px; margin: 0; color: var(--ink); white-space: pre-wrap;
    line-height: 1.6;
  }
  .callout {
    display: flex; gap: 10px; padding: 13px 14px; border-radius: 7px;
    font-size: 13.5px; margin: 0 0 14px; border: 1px solid;
  }
  .callout.ok { background: rgba(89,217,179,0.08); border-color: var(--accent-dim); color: var(--ink); }
  .callout.warn { background: var(--warn-bg); border-color: #4a3d1c; color: var(--ink); }
  .callout.error { background: var(--danger-bg); border-color: #4a281f; color: var(--ink); }
  .callout .mark { flex-shrink: 0; font-family: var(--mono); }
  .section-title {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-faint); margin: 26px 0 10px;
  }
  .stat-row { display: flex; gap: 18px; flex-wrap: wrap; margin: 4px 0 4px; }
  .stat {
    display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--ink-dim);
  }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
    border-radius: 999px; font-size: 12px; font-weight: 600; font-family: var(--mono);
  }
  .pill.on { background: rgba(89,217,179,0.12); color: var(--accent); }
  .pill.off { background: rgba(232,113,95,0.1); color: var(--danger); }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td {
    text-align: left; padding: 9px 10px; font-size: 13px; border-bottom: 1px solid var(--line-soft);
  }
  th {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--ink-faint); font-weight: 500;
  }
  td { color: var(--ink-dim); }
  td.kind { color: var(--ink); font-family: var(--mono); font-size: 12.5px; }
  td.detail { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
  .empty { color: var(--ink-faint); font-size: 13px; padding: 18px 0; }
  a.link { color: var(--accent); }
  footer.copy {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 12px; gap: 10px;
  }
  footer.copy small { color: var(--ink-faint); font-size: 11.5px; }
`;

const wireTrace = (stage: 0 | 1 | 2) => `
  <div class="trace" aria-hidden="true">
    <span class="node${stage >= 0 ? " on" : ""}">GHL subaccount</span>
    <span class="wire"></span>
    <span class="node${stage >= 1 ? " on" : ""}">Media bridge</span>
    <span class="wire"></span>
    <span class="node${stage >= 2 ? " on" : ""}">Assistable v3</span>
  </div>`;

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="dot"></span><span>Media MCP Bridge</span></div>
    ${body}
  </div>
</body>
</html>`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createPortalRouter(ctx: PortalCtx): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.send(shell("Media MCP — Connect", `
      <h1>Connect a subaccount</h1>
      <p class="lede">Wire a GHL location to an Assistable v3 assistant so it can read voice notes,
        photos, and documents contacts send in. Every credential below is checked live before
        anything is saved.</p>
      ${wireTrace(0)}
      <div class="panel">
        <form method="post" action="/setup">
          <fieldset>
            <legend>Subaccount</legend>
            <div class="field">
              <label for="label">Label <span class="hint">— a name you'll recognize on the dashboard</span></label>
              <input id="label" name="label" placeholder="e.g. Castiglia Insurance" required>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="locationId">GHL location ID</label>
                <input id="locationId" name="locationId" placeholder="loc_..." required>
              </div>
              <div class="field">
                <label for="assistantId">Default assistant ID</label>
                <input id="assistantId" name="assistantId" placeholder="asst_..." required>
              </div>
            </div>
          </fieldset>
          <fieldset>
            <legend>Credentials</legend>
            <div class="field">
              <label for="v3Key">Assistable v3 API key</label>
              <input id="v3Key" name="v3Key" type="password" autocomplete="off" required>
            </div>
            <div class="field">
              <label for="ghlPit">GHL Private Integration Token</label>
              <input id="ghlPit" name="ghlPit" type="password" autocomplete="off" required>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="provider">AI provider</label>
                <select id="provider" name="provider">
                  <option value="gemini">Gemini (recommended)</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div class="field">
                <label for="aiKey">Provider API key</label>
                <input id="aiKey" name="aiKey" type="password" autocomplete="off" required>
              </div>
            </div>
          </fieldset>
          <button type="submit" class="btn btn-primary">Validate &amp; connect</button>
        </form>
      </div>
    `));
  });

  router.post("/setup", async (req, res) => {
    const b = req.body as Record<string, string>;
    try {
      const r = await provisionTenant(ctx, {
        label: b.label, locationId: b.locationId, assistantId: b.assistantId,
        provider: b.provider === "openai" ? "openai" : "gemini",
        v3Key: b.v3Key, ghlPit: b.ghlPit, aiKey: b.aiKey,
      });
      const mcpUrl = `${ctx.publicBaseUrl}/mcp/${r.tenant.token}`;
      res.send(shell("Connected", `
        <h1>Connected</h1>
        <p class="lede">${esc(r.tenant.label)} is wired up. Point the assistant at the tool below
          and it will read attachments on demand.</p>
        ${wireTrace(2)}
        <div class="panel">
          <div class="callout ok">
            <span class="mark">&#10003;</span>
            <span>Credentials validated live against GHL and Assistable v3.</span>
          </div>
          ${r.warnings.map((w) => `
            <div class="callout warn">
              <span class="mark">!</span>
              <span>${esc(w)}</span>
            </div>`).join("")}
          <div class="section-title">Tool</div>
          <p>${r.toolId
            ? `<span class="pill on">analyze_attachment created</span> &nbsp; <code>${esc(r.toolId)}</code>`
            : `<span class="pill off">manual creation needed</span> — add a CUSTOM tool named
               <code>analyze_attachment</code> in the Assistable v3 dashboard pointing at the URL below.`}
          </p>
          <div class="section-title">MCP endpoint</div>
          <code>${esc(mcpUrl)}</code>
          <div class="section-title">Add to the assistant's prompt</div>
          <pre>${esc(PROMPT_SNIPPET)}</pre>
          <div class="btn-row">
            <a class="btn btn-primary" href="/dashboard/${r.tenant.token}">Open dashboard</a>
            <a class="btn btn-ghost" href="/">Connect another</a>
          </div>
        </div>
      `));
    } catch (err) {
      res.status(400).send(shell("Validation failed", `
        <h1>Connection failed</h1>
        <p class="lede">One of the credentials didn't check out. Nothing was saved.</p>
        ${wireTrace(0)}
        <div class="panel">
          <div class="callout error">
            <span class="mark">&#10007;</span>
            <span>${esc(err instanceof Error ? err.message : "Validation error")}</span>
          </div>
          <a class="btn btn-ghost" href="/">&larr; Back to setup</a>
        </div>
      `));
    }
  });

  router.get("/dashboard/:token", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) {
      res.status(404).send(shell("Not found", `
        <h1>Unknown dashboard</h1>
        <p class="lede">This link doesn't match any connected subaccount.</p>
        <a class="btn btn-ghost" href="/">&larr; Back to setup</a>
      `));
      return;
    }
    const events = ctx.events.latest(t.id, 20);
    const rows = events.map((e) => `
      <tr>
        <td>${esc(new Date(e.at).toISOString())}</td>
        <td class="kind">${esc(e.kind)}</td>
        <td class="detail">${esc(e.detail)}</td>
      </tr>`).join("");
    res.send(shell(`Dashboard — ${t.label}`, `
      <h1>${esc(t.label)}</h1>
      <p class="lede">GHL location <code>${esc(t.locationId)}</code> &middot; assistant <code>${esc(t.assistantId)}</code></p>
      ${wireTrace(t.enabled ? 2 : 1)}
      <div class="panel">
        <div class="stat-row">
          <span class="stat">Status <span class="pill ${t.enabled ? "on" : "off"}">${t.enabled ? "enabled" : "disabled"}</span></span>
          <span class="stat">Waker <span class="pill ${t.wakerEnabled ? "on" : "off"}">${t.wakerEnabled ? "on" : "off"}</span></span>
          <span class="stat">Provider <span class="pill on">${esc(t.provider)}</span></span>
          <span class="stat">Voice notes <span class="pill ${t.modalities.audio ? "on" : "off"}">${t.modalities.audio ? "on" : "off"}</span></span>
          <span class="stat">Images <span class="pill ${t.modalities.image ? "on" : "off"}">${t.modalities.image ? "on" : "off"}</span></span>
        </div>
        <form method="post" action="/dashboard/${t.token}/toggle">
          <div class="btn-row">
            <button class="btn btn-ghost" name="what" value="enabled">${t.enabled ? "Disable" : "Enable"} bridge</button>
            <button class="btn btn-ghost" name="what" value="waker">Turn waker ${t.wakerEnabled ? "off" : "on"}</button>
            <button class="btn btn-ghost" name="what" value="audio">Turn voice notes ${t.modalities.audio ? "off" : "on"}</button>
            <button class="btn btn-ghost" name="what" value="image">Turn images ${t.modalities.image ? "off" : "on"}</button>
          </div>
        </form>
        <div class="section-title">Recent activity</div>
        ${events.length === 0
          ? `<p class="empty">No events yet — activity will appear here once a contact sends an attachment.</p>`
          : `<table>
              <tr><th>Time</th><th>Event</th><th>Detail</th></tr>
              ${rows}
            </table>`}
        <footer class="copy">
          <small>Tool: ${t.toolId ? `analyze_attachment (${esc(t.toolId)})` : "not yet created"}</small>
          <small><code>${esc(ctx.publicBaseUrl)}/mcp/${t.token}</code></small>
        </footer>
      </div>
    `));
  });

  router.post("/dashboard/:token/toggle", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const what = (req.body as { what?: string }).what;
    if (what === "enabled") ctx.tenants.setEnabled(t.id, !t.enabled);
    if (what === "waker") ctx.tenants.setWaker(t.id, !t.wakerEnabled);
    if (what === "audio") ctx.tenants.setModality(t.id, "audio", !t.modalities.audio);
    if (what === "image") ctx.tenants.setModality(t.id, "image", !t.modalities.image);
    res.redirect(`/dashboard/${t.token}`);
  });

  return router;
}
