/**
 * GET /admin/client-env - emit the exact Claude Code configuration for a model.
 *
 * Connecting Claude Code to a local model needs several variables that must AGREE
 * with the loaded model, and each one fails differently when it does not:
 *
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS  must equal the model's real window, or Claude
 *                                   Code assumes 200K and never compacts in time
 *   CLAUDE_CODE_MAX_OUTPUT_TOKENS   must leave room for the prompt inside that same
 *                                   window; Claude Code otherwise asks for 32000
 *   CLAUDE_CODE_ATTRIBUTION_HEADER  0, or a varying prompt prefix costs the
 *                                   llama.cpp prompt cache on every single turn
 *
 * Publishing them from the registry means the numbers come from the same source of
 * truth the backend is launched with, instead of being copied into a README and
 * going stale the moment someone edits models.yaml.
 *
 * EVERY MODEL SLOT IS PINNED TO THE SAME ID. See MODEL_SLOTS below - the repetition
 * is the point, not an oversight.
 */

import type { ServerResponse } from "node:http";
import type { Registry } from "../registry.ts";
import type { Config } from "../config.ts";

/** Fraction of the window handed to output; the rest is prompt headroom. */
const OUTPUT_SHARE = 0.25;
const MIN_OUTPUT = 1024;

/**
 * Smallest window that holds Claude Code's opening request unpruned.
 *
 * Measured on 2.1.236: ~27,800 tokens of system prompt and tool schemas arrive before
 * the conversation starts. A 32K model serves that; a 16K one fails on its first
 * message with `prompt is too long`. Used to decide whether to tell the user that tool
 * pruning is mandatory rather than optional.
 */
const TOOLSET_TOKENS = 32768;

/**
 * Every variable through which Claude Code can name a model. All of them are set to
 * the SAME id, and that is deliberate.
 *
 * Claude Code drives several model slots - main, the Opus/Sonnet/Haiku tier aliases,
 * and a subagent slot. A hosted provider can point them at different models because
 * every model is resident at once. We hold exactly one model in VRAM, so naming a
 * second one anywhere here means the slot that uses it is a genuine, explicitly
 * requested id: `fellBack` is false, RequestContext.chooseTarget honours it verbatim,
 * and the backend swaps. The next main-slot request swaps back. That is a 10-90s
 * eviction per turn - precisely the thrash BACKGROUND_STRATEGY=reuse-primary exists to
 * prevent, and reuse-primary CANNOT prevent it here, because it only engages for ids
 * the registry does not recognise.
 *
 * Pinning every slot also removes a fragile assumption. Without these, correct
 * behaviour depends on Claude Code's background slot happening to send an id we do not
 * recognise - an inference about another program's defaults, which can change under
 * us. Pinned, every slot sends a known id, nothing ever falls back, and reuse-primary
 * becomes a safety net rather than the load-bearing mechanism.
 *
 * Serving two models at once would need a second llama-server process and combined
 * VRAM accounting; the supervisor is built around exactly one backend.
 */
const MODEL_SLOTS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export function buildClientEnv(
  registry: Registry,
  cfg: Config,
  requestedId: string | null,
): { model: string; env: Record<string, string>; notes: string[] } {
  const { model } = registry.resolve(requestedId ?? undefined);
  const output = Math.max(MIN_OUTPUT, Math.floor(model.context * OUTPUT_SHARE));

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "http://localhost:" + cfg.port,
    // The real secret when one is configured, so the emitted block actually works.
    // Claude Code sends this as `Authorization: Bearer`; with auth off, any non-empty
    // placeholder is fine and the gateway ignores it.
    ANTHROPIC_AUTH_TOKEN: cfg.gatewayApiKey ?? "local-gateway",
    // Every model slot, same id. The repetition is load-bearing; see MODEL_SLOTS.
    ...Object.fromEntries(MODEL_SLOTS.map((k) => [k, model.id] as const)),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.context),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(output),
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    MAX_THINKING_TOKENS: "0",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };

  const notes: string[] = [];
  if (!model.capabilities.includes("tools")) {
    notes.push(
      "WARNING: " + model.id + " has no tool-calling support, so Claude Code's agent " +
        "loop will not work with it. Pick a model whose capabilities include `tools`.",
    );
  }
  // Only nag about pruning when the window genuinely cannot hold Claude Code's opening
  // request. Measured on 2.1.236: ~27,800 tokens of system prompt plus tool schemas
  // before the conversation starts. A 32K window swallows that; 16K fails on the FIRST
  // message. Telling someone with a 64K model to prune is stale advice from when the
  // default was 16K, and it costs them tools they could have had.
  if (model.context < TOOLSET_TOKENS) {
    notes.push(
      "REQUIRED: " + model.id + " has a " + model.context + "-token window, and Claude " +
        "Code sends ~27,800 tokens of tool schemas before you type anything - an " +
        'unpruned session fails on its first message. Run `claude --tools ' +
        '"Read,Edit,Grep,Glob,Bash"`, or set TOOL_PROFILE=coding on the container.',
    );
  }
  if (!model.available) {
    notes.push("WARNING: " + model.id + " is unavailable: " + (model.unavailableReason ?? ""));
  }
  return { model: model.id, env, notes };
}

/**
 * The block printed once at startup, so the container tells you how to use it.
 *
 * Deliberately written to STDOUT rather than through `log`, because the log line
 * prefix (timestamp, level) would end up inside anything you copied. The whole point
 * is that the JSON below can be selected and pasted without editing - including out of
 * Docker Desktop's log pane, which is where most people will first meet this.
 *
 * The values come from buildClientEnv, so they cannot drift from what
 * /admin/client-env serves or from the model actually loaded.
 */
export function startupBanner(registry: Registry, cfg: Config): string {
  const { model, env, notes } = buildClientEnv(registry, cfg, null);
  const url = env.ANTHROPIC_BASE_URL ?? "http://localhost:" + cfg.port;
  const settings = JSON.stringify({ env }, null, 2);
  const bar = "=".repeat(78);

  const lines = [
    "",
    bar,
    "  claude-code-local-llm is ready at " + url,
    "  serving: " + model,
    bar,
    "",
    "  OPTION A - point Claude Code at it permanently.",
    "  Paste this into your Claude Code settings file:",
    "",
    "    Linux/macOS   ~/.claude/settings.json",
    "    Windows       %USERPROFILE%\\.claude\\settings.json",
    "",
    settings.split("\n").map((l) => "  " + l).join("\n"),
    "",
    "  OPTION B - just this shell session:",
    "",
    // The URL is quoted: `?` is a glob character, and an unquoted URL only survives
    // because bash leaves a non-matching glob alone - which stops being true under
    // `failglob`, and was never true in zsh, where it is an outright error.
    '    bash    eval "$(curl -s \'' + url + "/admin/client-env?format=sh' | grep ^export)\"",
    // curl.exe, not curl. In Windows PowerShell `curl` is an ALIAS for
    // Invoke-WebRequest, so `-s` binds as a PowerShell parameter and the command dies
    // with "missing mandatory parameters: Uri" before it ever fetches anything. That
    // is the default shell on the platform this container is most often run from.
    "    pwsh    curl.exe -s '" + url + "/admin/client-env?format=ps1' | Invoke-Expression",
    "",
    "  Then run Claude Code as usual:",
    "",
    "    claude",
    // Only open a gap when there is actually something to put in it.
    ...(notes.length > 0 ? ["", ...notes.map((n) => "  ! " + n)] : []),
    "",
    "  Other models:  curl -s " + url + "/admin/models",
    "  Config for one: curl -s '" + url + "/admin/client-env?model=<id>'",
    bar,
    "",
  ];
  return lines.join("\n");
}

export function handleClientEnv(
  res: ServerResponse,
  registry: Registry,
  cfg: Config,
  requestedId: string | null,
  format: string | null,
): void {
  const { model, env, notes } = buildClientEnv(registry, cfg, requestedId);

  if (format === "sh" || format === "ps1") {
    const lines: string[] = [];
    for (const note of notes) lines.push("# " + note);
    for (const [k, v] of Object.entries(env)) {
      lines.push(format === "ps1" ? `$env:${k} = "${v}"` : `export ${k}="${v}"`);
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(lines.join("\n") + "\n");
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model, env, notes }, null, 2));
}
