/**
 * GET / and GET /help - the container explaining itself in a browser.
 *
 * Someone who starts this and opens localhost:8787 should find documentation, not a
 * 404. /admin/config already serves the same facts as JSON, which is right for a script
 * and wrong for a person reading it for the first time.
 *
 * Everything here is generated from the live registry and config, so it cannot describe
 * a gateway other than the one serving it - the models listed are the models this
 * process actually has, with this host's availability, and the settings shown are the
 * ones in force.
 *
 * NO AUTH ON THIS ROUTE. It is documentation, and someone who cannot get in is exactly
 * the person who needs to read how to configure the credential. That makes redaction
 * load-bearing rather than tidy: `secret` options report only whether they are set.
 *
 * Self-contained by necessity - a gateway on a laptop with no internet still has to
 * render, so there are no external stylesheets, fonts or scripts.
 */

import type { ServerResponse } from "node:http";
import { OPTIONS, EXAMPLES, REPO, type Config } from "./config.ts";
import { buildClientEnv } from "./anthropic/client_env.ts";
import { ENDPOINTS } from "./endpoints.ts";
import type { Registry } from "./registry.ts";

/** Escape for HTML text and attributes. Model names and settings are not trusted input. */
function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root {
  --bg: #fbfbfa; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e0;
  --card: #ffffff; --code-bg: #f4f4f2; --accent: #b4552d; --ok: #2d7a4a; --warn: #a8600a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --fg: #e8e6e3; --muted: #9a9894; --line: #2c2b28;
    --card: #1c1b19; --code-bg: #232220; --accent: #d97757; --ok: #6bbb84; --warn: #d9a04a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .2rem; letter-spacing: -.02em; }
h2 {
  font-size: 1.05rem; margin: 2.5rem 0 .75rem; padding-bottom: .35rem;
  border-bottom: 1px solid var(--line); letter-spacing: -.01em;
}
h3 { font-size: .92rem; margin: 1.5rem 0 .4rem; color: var(--muted); font-weight: 600; }
p { margin: .6rem 0; }
a { color: var(--accent); }
.sub { color: var(--muted); margin: 0 0 1.25rem; }
code, pre { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 13px; }
code { background: var(--code-bg); padding: .12em .35em; border-radius: 3px; }
pre {
  background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px;
  padding: .8rem 1rem; overflow-x: auto; margin: .5rem 0;
}
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0; display: block; overflow-x: auto; }
th, td { text-align: left; padding: .45rem .7rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
td.n { white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
.badge { display: inline-block; padding: .1em .5em; border-radius: 10px; font-size: .75rem; font-weight: 600; }
.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.no { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.15rem; margin: .75rem 0; }
.warn { border-left: 3px solid var(--warn); }
.muted { color: var(--muted); }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
`;

export function renderHelp(registry: Registry, cfg: Config, loadedId: string | null): string {
  const { model, env } = buildClientEnv(registry, cfg, null);
  const url = "http://localhost:" + cfg.port;
  const models = registry.list();

  // ANTHROPIC_AUTH_TOKEN carries the real GATEWAY_API_KEY when authentication is on,
  // and this page has no auth in front of it. Printing the settings block verbatim
  // would hand the credential to exactly the caller it exists to keep out. The sh/ps1
  // endpoints may emit it - they sit behind /admin and you need the key to reach them -
  // but this page must not.
  const shown: Record<string, string> = { ...env };
  const redacted = cfg.gatewayApiKey !== null;
  if (redacted) shown.ANTHROPIC_AUTH_TOKEN = "<your GATEWAY_API_KEY>";
  const settings = JSON.stringify({ env: shown }, null, 2);

  const modelRows = models
    .map((m) => {
      const badge = m.available
        ? '<span class="badge ok">available</span>'
        : `<span class="badge no">${esc(m.unavailableReason ?? "unavailable")}</span>`;
      const here = m.id === loadedId ? " &nbsp;<span class=\"muted\">&larr; loaded</span>" : "";
      return `<tr><td class="n">${esc(m.id)}${here}</td><td>${esc(m.display_name ?? "")}</td>` +
        `<td class="n">${esc(m.size_gb)} GB</td><td class="n">${Math.round(m.context / 1024)}K</td>` +
        `<td>${badge}</td></tr>`;
    })
    .join("");

  const optionRows = OPTIONS.map((o) => {
    const raw = process.env[o.name];
    const cur = o.secret ? (raw ? "(set)" : "") : raw ?? "";
    return `<tr><td class="n">${esc(o.name)}</td><td class="n muted">${esc(o.def)}</td>` +
      `<td class="n">${esc(cur)}</td><td>${esc(o.doc)}</td></tr>`;
  }).join("");

  const exampleBlocks = EXAMPLES.map(
    (e) =>
      `<h3>${esc(e.what)}</h3><pre><code>${esc(e.run)}</code></pre>` +
      `<p class="muted">${esc(e.why)}</p>`,
  ).join("");

  const authOn = cfg.gatewayApiKey !== null;
  const endpointRows = ENDPOINTS.map((e) => {
    const params = [
      ...(e.query ?? []).map((q) => `<div><code>?${esc(q.split(" - ")[0])}</code>` +
        (q.includes(" - ") ? ` <span class="muted">${esc(q.split(" - ").slice(1).join(" - "))}</span>` : "") +
        "</div>"),
      ...(e.body ? [`<div class="muted">body <code>${esc(e.body)}</code></div>`] : []),
    ].join("");
    const lock = e.auth && authOn ? ' <span class="badge no">auth</span>' : "";
    return `<tr><td class="n">${esc(e.method)} ${esc(e.path)}${lock}</td>` +
      `<td>${params || '<span class="muted">none</span>'}</td><td>${esc(e.what)}</td></tr>`;
  }).join("");

  const pruning = cfg.toolProfile
    ? `<div class="card"><strong>Tool pruning is on</strong> (<code>TOOL_PROFILE=${esc(cfg.toolProfile)}</code>), ` +
      `so you can launch Claude Code without a <code>--tools</code> flag.</div>`
    : `<div class="card warn"><strong>No tool pruning configured.</strong> Claude Code sends ~36 tool
       definitions on every request. Measured on a 64K model: <strong>38.7K tokens</strong> of schemas
       left 5.7K for the conversation and it compacted every few turns; pruning to seven tools left
       24.7K and it never did. Keep the <code>--tools</code> list below, or set
       <code>TOOL_PROFILE=coding</code> on the container.</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-code-local-llm</title><style>${CSS}</style></head>
<body><main>

<h1>claude-code-local-llm</h1>
<p class="sub">Run any local GGUF model behind Claude Code &middot;
  <a href="${esc(REPO)}">${esc(REPO)}</a></p>

<div class="card">Serving <code>${esc(model)}</code> at <code>${esc(url)}</code> &middot;
  ${models.filter((m) => m.available).length} of ${models.length} models available on this host.</div>

<h2>Point Claude Code at this gateway</h2>
<h3>bash / zsh</h3>
<pre><code>eval "$(curl -s '${esc(url)}/admin/client-env?format=sh' | grep ^export)"</code></pre>
<h3>PowerShell &mdash; note <code>curl.exe</code>, not <code>curl</code></h3>
<pre><code>curl.exe -s "${esc(url)}/admin/client-env?format=ps1" | Invoke-Expression</code></pre>
<p class="muted">In Windows PowerShell <code>curl</code> is an alias for
  <code>Invoke-WebRequest</code>, so <code>-s</code> binds as a PowerShell parameter and the
  command fails before fetching anything.</p>

${pruning}

<h3>Then launch</h3>
<pre><code>${cfg.toolProfile ? "claude" : 'claude --tools "Read,Write,Edit,Bash,Glob,Grep,TodoWrite"'}</code></pre>

<h3>Or make it permanent</h3>
<p class="muted">Add this <code>env</code> block to your Claude Code settings file
  (<code>~/.claude/settings.json</code>, or <code>%USERPROFILE%\\.claude\\settings.json</code>).
  <strong>Merge it</strong> into what is already there rather than replacing the file, and note it
  applies to every Claude Code session on the machine &mdash; scope it to a project with
  <code>.claude/settings.json</code> if you would rather not.</p>
<pre><code>${esc(settings)}</code></pre>
${redacted
  ? '<p class="muted">This gateway requires a credential, so the token is not printed here &mdash; ' +
    "substitute the <code>GATEWAY_API_KEY</code> it was started with. The " +
    "<code>/admin/client-env</code> commands above fill it in for you, since reaching them " +
    "already requires the key.</p>"
  : ""}

<h2>Models</h2>
<table><thead><tr><th>id</th><th>name</th><th>size</th><th>context</th><th>status</th></tr></thead>
<tbody>${modelRows}</tbody></table>
<p class="muted">Add your own with <code>POST /admin/models</code>; see the repository for the fields.</p>

<h2>Settings</h2>
<p class="muted">Set with <code>-e NAME=value</code> on <code>docker run</code>, or under
  <code>environment:</code> in <code>docker-compose.yml</code>. The same data as JSON:
  <code>GET /admin/config</code>.</p>
<table><thead><tr><th>variable</th><th>default</th><th>current</th><th>what it does</th></tr></thead>
<tbody>${optionRows}</tbody></table>

<h2>Examples</h2>
${exampleBlocks}

<h2>Endpoints</h2>
<p class="muted">${authOn
  ? "Routes marked <strong>auth</strong> need <code>Authorization: Bearer &lt;GATEWAY_API_KEY&gt;</code> or <code>x-api-key</code>."
  : "No credential is configured, so none of these require one. Set <code>GATEWAY_API_KEY</code> before exposing the port."}</p>
<table><thead><tr><th>route</th><th>parameters</th><th>what it does</th></tr></thead>
<tbody>${endpointRows}</tbody></table>

<footer>Generated by this gateway from its own configuration &middot;
  <a href="${esc(REPO)}">${esc(REPO)}</a></footer>
</main></body></html>`;
}
