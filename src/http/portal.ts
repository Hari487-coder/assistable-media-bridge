import { Router } from "express";
import { parseBatchRows, provisionBatch, redactPits } from "../core/batch";
import { PROMPT_SNIPPET, type ProvisionDeps, ensureTool, provisionTenant } from "../core/provision";
import type { EventStore } from "../store/events";
import { MAX_ANALYSIS_INSTRUCTION } from "../store/tenants";

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
  .journey {
    display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 28px;
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.05em;
  }
  .journey .s {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 13px 7px 8px; border: 1px solid var(--line);
    border-radius: 999px; color: var(--ink-faint); background: var(--panel-2);
  }
  .journey .s b { font-weight: 600; }
  .journey .s.now { color: var(--ink); border-color: var(--accent-dim); }
  .journey .s.done { color: var(--accent); border-color: var(--accent-dim); }
  .journey .s .n {
    width: 17px; height: 17px; border-radius: 50%; display: grid;
    place-items: center; font-size: 10px; background: var(--panel);
    border: 1px solid var(--line); color: inherit;
  }
  .journey .s.done .n {
    background: var(--accent-dim); border-color: var(--accent-dim); color: var(--accent);
  }
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
  input, select, textarea {
    width: 100%; padding: 10px 12px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 7px; color: var(--ink);
    font-size: 14px; font-family: var(--sans); outline: none;
    transition: border-color 0.15s ease;
  }
  input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible {
    border-color: var(--accent); outline: 2px solid var(--accent-dim); outline-offset: 1px;
  }
  input::placeholder, textarea::placeholder { color: var(--ink-faint); }
  textarea {
    font-family: var(--mono); font-size: 13px; line-height: 1.7;
    min-height: 190px; resize: vertical; white-space: pre;
  }
  .altlink {
    margin: 14px 0 0; font-size: 13px; color: var(--ink-faint); text-align: center;
  }
  .pill.warnpill { background: var(--warn-bg); color: var(--warn); }
  td.why { color: var(--ink-dim); font-size: 12.5px; }
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
  <title>${esc(title)}</title>
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
      <div class="journey" aria-label="Setup progress">
        <span class="s done"><span class="n">✓</span> <b>Deployed</b> · your instance</span>
        <span class="s now"><span class="n">2</span> <b>Connect</b> your account</span>
        <span class="s"><span class="n">3</span> <b>Test</b> a voice note</span>
      </div>
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
              <input id="label" name="label" placeholder="e.g. Main Street Dental" required>
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
            <div class="field">
              <label for="subAccountId">Subaccount ID <span class="hint">— optional, only if your API key covers multiple subaccounts</span></label>
              <input id="subAccountId" name="subAccountId" placeholder="leave blank for a single-subaccount key">
            </div>
          </fieldset>
          <fieldset>
            <legend>Credentials</legend>
            <div class="field">
              <label for="v3Key">Assistable v3 API key <span class="hint">— starts with <code>ask_live_</code>; mint one under Dashboard &rarr; Integrations &rarr; API Key</span></label>
              <input id="v3Key" name="v3Key" type="password" autocomplete="off"
                pattern="ask_(live|stag)_.+" title="A v3 API key starts with ask_live_ (Dashboard -> Integrations -> API Key). Older portal keys and tokens from other pages will not work." required>
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
        <p class="altlink">Running an agency?
          <a class="link" href="/setup/batch">Connect several subaccounts at once &rarr;</a></p>
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
        ...(b.subAccountId?.trim() ? { subAccountId: b.subAccountId.trim() } : {}),
      });
      const mcpUrl = `${ctx.publicBaseUrl}/mcp/${r.tenant.token}`;
      const title = r.reconnected ? "Reconnected" : "Connected";
      res.send(shell(title, `
        <h1>${title}</h1>
        <p class="lede">${esc(r.tenant.label)} is wired up. Point the assistant at the tool below
          and it will read attachments on demand.</p>
        ${wireTrace(2)}
        <div class="panel">
          <div class="callout ok">
            <span class="mark">&#10003;</span>
            <span>Credentials validated live against GHL and Assistable v3.</span>
          </div>
          ${r.reconnected ? `
            <div class="callout ok">
              <span class="mark">&#8635;</span>
              <span>This GHL location was already connected, so its settings were updated in place
                rather than added twice. The tool URL, dashboard link and activity history below are
                unchanged, and already-read attachments stay read.</span>
            </div>` : ""}
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

  // ---- bulk setup ------------------------------------------------------
  // An agency runs ONE Assistable workspace across many subaccounts, so the
  // three credentials are identical on every row and only the identifiers
  // differ. Pasting them 40 times is the whole friction.

  const batchCredentialFields = `
    <fieldset>
      <legend>Shared credentials</legend>
      <p class="lede" style="margin-bottom:14px">Used for every subaccount below. The v3 key must be
        workspace-wide, so it can reach each subaccount you list.</p>
      <div class="field">
        <label for="v3Key">Assistable v3 API key <span class="hint">— starts with <code>ask_live_</code></span></label>
        <input id="v3Key" name="v3Key" type="password" autocomplete="off"
          pattern="ask_(live|stag)_.+" title="A v3 API key starts with ask_live_." required>
      </div>
      <div class="field">
        <label for="ghlPit">GHL Private Integration Token <span class="hint">— optional if every row
          carries its own <code>pit=</code>. A private integration may be agency-wide or scoped to one
          location depending on how it was minted; if yours only covers one location, leave this blank
          and put <code>pit=&lt;token&gt;</code> on each row instead.</span></label>
        <input id="ghlPit" name="ghlPit" type="password" autocomplete="off">
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
    </fieldset>`;

  const batchForm = (rowsText: string, error?: string) => `
    <h1>Connect several subaccounts</h1>
    <p class="lede">Paste your credentials once, then list the subaccounts. Every row is validated
      against the live APIs on its own — one bad line fails that row, not the batch.</p>
    ${wireTrace(0)}
    <div class="panel">
      ${error ? `<div class="callout error"><span class="mark">&#10007;</span><span>${esc(error)}</span></div>` : ""}
      <form method="post" action="/setup/batch">
        ${batchCredentialFields}
        <fieldset>
          <legend>Subaccounts</legend>
          <div class="field">
            <label for="rows">One per line <span class="hint">— <code>subAccountId, locationId, assistantId, label</code>.
              Commas or tabs, so a spreadsheet paste works. Leave the assistant blank and it is filled
              in automatically when the subaccount has exactly one. Add <code>pit=&lt;token&gt;</code>
              anywhere in a row to give that location its own GHL token.</span></label>
            <textarea id="rows" name="rows" spellcheck="false" required
              placeholder="sub_a1b2, loc_9f8e, asst_1234, Main Street Dental&#10;sub_c3d4, loc_7a6b, , Riverside Chiropractic&#10;sub_e5f6, loc_5c4d, , Lakeside Vets, pit=pit-abc123">${esc(rowsText)}</textarea>
          </div>
        </fieldset>
        <button type="submit" class="btn btn-primary">Validate &amp; connect all</button>
      </form>
      <p class="altlink">Just one subaccount? <a class="link" href="/">Use the single form &rarr;</a></p>
    </div>`;

  router.get("/setup/batch", (_req, res) => {
    res.send(shell("Media MCP — Bulk connect", batchForm("")));
  });

  router.post("/setup/batch", async (req, res) => {
    const b = req.body as Record<string, string>;
    const rowsText = b.rows ?? "";
    const { rows, errors } = parseBatchRows(rowsText);
    if (rows.length === 0) {
      const why = errors.length
        ? errors.map((e) => (e.line ? `line ${e.line}: ${e.error}` : e.error)).join(" · ")
        : "no subaccounts were listed";
      // Echo the list back so the operator can fix it in place, but never write
      // live tokens into an HTML response a proxy or log might retain.
      const safe = redactPits(rowsText);
      const note = safe === rowsText
        ? why
        : `${why}. Your pit= tokens were removed from this form — re-add them before submitting.`;
      res.status(400).send(shell("Nothing to connect", batchForm(safe, note)));
      return;
    }

    const results = await provisionBatch(
      ctx,
      {
        provider: b.provider === "openai" ? "openai" : "gemini",
        v3Key: b.v3Key, ghlPit: b.ghlPit, aiKey: b.aiKey,
      },
      rows
    );

    const connected = results.filter((r) => r.ok && !r.reconnected).length;
    const reconnected = results.filter((r) => r.ok && r.reconnected).length;
    const failed = results.filter((r) => !r.ok);

    const statusCell = (r: (typeof results)[number]) => {
      if (!r.ok) return `<span class="pill off">failed</span>`;
      if (r.warnings.length) return `<span class="pill warnpill">needs attention</span>`;
      return `<span class="pill on">${r.reconnected ? "reconnected" : "connected"}</span>`;
    };
    const detailCell = (r: (typeof results)[number]) => {
      if (!r.ok) return esc(r.error ?? "provisioning failed");
      const bits = [
        r.toolId ? `tool ${esc(r.toolId)}` : "tool not created",
        `<a class="link" href="/dashboard/${r.token}">dashboard</a>`,
      ];
      if (r.warnings.length) bits.push(esc(r.warnings.join("; ")));
      return bits.join(" &middot; ");
    };
    const resultRows = results.map((r) => `
      <tr>
        <td class="kind">${esc(r.row.locationId)}</td>
        <td class="detail">${esc(r.row.subAccountId)}</td>
        <td class="detail">${esc(r.assistantId ?? "—")}</td>
        <td>${statusCell(r)}</td>
        <td class="why">${detailCell(r)}</td>
      </tr>`).join("");

    res.send(shell("Bulk connect results", `
      <h1>${connected + reconnected} of ${results.length} connected</h1>
      <p class="lede">Every row was validated live. Re-submitting the same list is safe — rows that
        already worked reconnect in place rather than duplicating, so fix the failures below and
        paste the whole list again.</p>
      ${wireTrace(failed.length === results.length ? 0 : 2)}
      <div class="panel">
        <div class="stat-row">
          <span class="stat">New <span class="pill on">${connected}</span></span>
          <span class="stat">Reconnected <span class="pill on">${reconnected}</span></span>
          <span class="stat">Failed <span class="pill ${failed.length ? "off" : "on"}">${failed.length}</span></span>
        </div>
        ${errors.length ? `
          <div class="callout warn">
            <span class="mark">!</span>
            <span>${errors.length} line(s) were skipped as unparseable:
              ${esc(errors.map((e) => `line ${e.line}`).join(", "))}</span>
          </div>` : ""}
        <div class="section-title">Results</div>
        <table>
          <tr><th>Location</th><th>Subaccount</th><th>Assistant</th><th>Status</th><th>Detail</th></tr>
          ${resultRows}
        </table>
        <div class="section-title">Add to every connected assistant's prompt</div>
        <pre>${esc(PROMPT_SNIPPET)}</pre>
        <div class="btn-row">
          <a class="btn btn-ghost" href="/setup/batch">Connect more</a>
        </div>
      </div>
    `));
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
        <div class="section-title">What to look for</div>
        <form method="post" action="/dashboard/${t.token}/instruction">
          <div class="field">
            <label for="instruction">Extra guidance <span class="hint">— appended to the built-in
              extraction prompt for every attachment. Leave blank for the default.</span></label>
            <textarea id="instruction" name="instruction" spellcheck="false" style="min-height:96px"
              maxlength="${MAX_ANALYSIS_INSTRUCTION}"
              placeholder="e.g. Receipts are common here. Always extract the amount, currency, date, payer name and any reference or transaction number.">${esc(t.analysisInstruction ?? "")}</textarea>
          </div>
          <div class="callout warn">
            <span class="mark">!</span>
            <span>This changes what the reader <em>extracts</em>, not what is true. A screenshot can be
              edited in seconds and models misread digits, so never let the assistant confirm a payment
              on this alone — check it against your payment provider or invoice record.</span>
          </div>
          <div class="btn-row">
            <button class="btn btn-ghost">Save guidance</button>
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
        ${t.toolId ? "" : `
        <form method="post" action="/dashboard/${t.token}/retry-tool">
          <div class="btn-row">
            <button class="btn btn-primary">Retry tool setup</button>
          </div>
        </form>`}
      </div>
    `));
  });

  // Re-run tool create/recover/assign for an already-connected tenant. The
  // onboarding path can leave toolId null (e.g. platform-side create failure);
  // this makes that state recoverable in one click instead of forcing a
  // re-onboard (which would duplicate the tenant and double-wake conversations).
  router.post("/dashboard/:token/retry-tool", async (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    try {
      const v3 = ctx.v3Factory(t.v3Key, t.subAccountId);
      const r = await ensureTool(v3, ctx.tenants, ctx.publicBaseUrl, t);
      if (r.toolId) {
        ctx.events.record(t.id, "assign", `tool ready (${r.toolId})${r.warnings.length ? ` — ${r.warnings.join("; ")}` : ""}`);
      } else {
        ctx.events.record(t.id, "error", `tool retry failed: ${r.warnings.join("; ")}`);
      }
    } catch (err) {
      ctx.events.record(t.id, "error", `tool retry failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
    res.redirect(`/dashboard/${t.token}`);
  });

  router.post("/dashboard/:token/instruction", (req, res) => {
    const t = ctx.tenants.getByToken(req.params.token);
    if (!t) { res.status(404).end(); return; }
    const text = (req.body as { instruction?: string }).instruction ?? "";
    ctx.tenants.setAnalysisInstruction(t.id, text);
    const clean = text.trim();
    ctx.events.record(
      t.id, "config",
      clean ? `analysis guidance set (${Math.min(clean.length, MAX_ANALYSIS_INSTRUCTION)} chars)` : "analysis guidance cleared"
    );
    res.redirect(`/dashboard/${t.token}`);
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
