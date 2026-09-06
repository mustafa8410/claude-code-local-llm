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
import type { Registry, ResolvedModel } from "../registry.ts";
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
 * Every variable through which Claude Code can name a model.
 *
 * These used to be pinned to a single id, on the reasoning that one model is resident
 * so naming a second anywhere costs a 10-90s swap. That is true, and it was still the
 * wrong trade: it made `/model` show the same name three times, and it made the whole
 * swap path - keepalives during eviction, single-flight, the supervisor's reload -
 * dead weight, since nothing could ever ask for a different model.
 *
 * They now split by role. The three TIER slots take different models, because choosing
 * one is a deliberate act and a swap is the correct price for it. The SUBAGENT slot
 * stays on the primary, because a subagent is spawned by the agent rather than chosen
 * by the user - that is the one case where a swap would be nobody's decision.
 *
 * Serving two models at once would still need a second llama-server process and
 * combined VRAM accounting; the supervisor is built around exactly one backend, so
 * these remain choices between models rather than a way to run several.
 */
const MODEL_SLOTS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * Which model each `/model` tier selects.
 *
 * Claude Code's picker is built from ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL - the
 * three rows are those variables, labelled from the matching *_MODEL_NAME. There are
 * exactly three because Claude Code defines three; it is not a limit on the catalog,
 * which can hold as many models as you like. Anything outside the three is still
 * reachable by naming it in ANTHROPIC_MODEL.
 *
 * OFF BY DEFAULT, and the reason is the whole story of this function.
 *
 * Giving each tier a different model looks obviously right: the picker becomes three
 * real choices instead of one name three times, and a swap is a fair price for a
 * deliberate switch. It was measured first, too - three tiers on three models, an
 * ordinary edit task, 1 spawn and 0 swaps. Claude Code appeared not to touch a tier
 * unless asked.
 *
 * That measurement used `--print`, which has no compaction and no background work, and
 * it was wrong about the thing that mattered. An interactive session alternates:
 *
 *   ready 2b -> stopping 2b (17 ms later) -> load 9b -> ready -> stopping -> load 2b
 *   ... interleaved with `backend unreachable: fetch failed`
 *
 * Claude Code runs side tasks - titling, and the summarising half of compaction - on
 * the small/fast tier on purpose. Against a hosted provider that is free, because every
 * model is already resident. Against one GPU it is a full load each way, so the session
 * spends its time swapping and requests fail outright mid-flight.
 *
 * That alternation is almost certainly also the answer to an older mystery: a soak once
 * logged 36 effort changes and 35 reloads that were blamed on effort handling and never
 * reproduced. With every slot pinned to one id the same alternation could not swap
 * models, so it surfaced as budget churn instead. One cause, two symptoms.
 *
 * So the tiers follow the primary, and the picker gets its choices from gateway model
 * discovery instead - which lists the entire catalog, not three of it. TIER_MODE=distinct
 * turns this on for anyone who wants it, and TIER_* pins individual slots either way.
 */
function pickTiers(
  candidates: readonly ResolvedModel[],
  fallback: string,
): { opus: string; sonnet: string; haiku: string } {
  const usable = candidates.filter((m) => m.available && m.capabilities.includes("tools"));
  if (usable.length === 0) return { opus: fallback, sonnet: fallback, haiku: fallback };

  // Biggest is the most capable, smallest is the fastest - which is what the Opus and
  // Haiku names mean to anyone who has used the hosted models.
  const sorted = [...usable].sort((a, b) => b.size_gb - a.size_gb);

  // One entry per set of WEIGHTS, not per catalog entry. The catalog ships the 9B twice
  // - once plain, once with the vision projector - and they are the same download. With
  // both in the running, "balanced" picked the second 9B and the picker offered the
  // same model under two names while the 4B, the genuinely mid-sized option, went
  // unoffered. Ties keep the first, which is the larger-window variant.
  const seen = new Set<string>();
  const bySize = sorted.filter((m) => {
    const weights = m.hf ?? m.path ?? m.id;
    if (seen.has(weights)) return false;
    seen.add(weights);
    return true;
  });
  const opus = bySize[0]!;
  const haiku = bySize[bySize.length - 1]!;
  // Prefer a genuine middle entry; with only two distinct models Sonnet doubles the
  // larger one rather than inventing a third.
  const sonnet = bySize.length >= 3 ? bySize[Math.floor((bySize.length - 1) / 2)]! : opus;
  return { opus: opus.id, sonnet: sonnet.id, haiku: haiku.id };
}

/** A short, honest description for the picker row. */
function tierNote(m: ResolvedModel | undefined, role: string): string {
  if (!m) return role;
  return role + " - " + m.size_gb + " GB, " + Math.round(m.context / 1024) + "K context";
}

export function buildClientEnv(
  registry: Registry,
  cfg: Config,
  requestedId: string | null,
): { model: string; env: Record<string, string>; notes: string[] } {
  const { model } = registry.resolve(requestedId ?? undefined);
  const output = Math.max(MIN_OUTPUT, Math.floor(model.context * OUTPUT_SHARE));

  const all = registry.list();

  // Tiers follow the primary by default. TIER_MODE=distinct opts into one model per
  // tier; TIER_OPUS/SONNET/HAIKU override either way. See the block above pickTiers.
  const auto = cfg.tierMode === "distinct"
    ? pickTiers(all, model.id)
    : { opus: model.id, sonnet: model.id, haiku: model.id };
  const tiers = {
    opus: cfg.tierOpus ?? auto.opus,
    sonnet: cfg.tierSonnet ?? auto.sonnet,
    haiku: cfg.tierHaiku ?? auto.haiku,
  };
  const byId = (id: string): ResolvedModel | undefined => all.find((m) => m.id === id);

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "http://localhost:" + cfg.port,
    // The real secret when one is configured, so the emitted block actually works.
    // Claude Code sends this as `Authorization: Bearer`; with auth off, any non-empty
    // placeholder is fine and the gateway ignores it.
    ANTHROPIC_AUTH_TOKEN: cfg.gatewayApiKey ?? "local-gateway",

    // The model a request goes to when no tier is chosen.
    ANTHROPIC_MODEL: model.id,
    // The three /model rows. Distinct on purpose - see pickTiers.
    ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.haiku,
    // Labels, so the picker reads as three real choices rather than three ids.
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: tiers.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: tiers.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: tiers.haiku,
    ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: tierNote(byId(tiers.opus), "best quality"),
    ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: tierNote(byId(tiers.sonnet), "balanced"),
    ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: tierNote(byId(tiers.haiku), "fastest"),

    // Subagents follow the primary deliberately. A subagent is spawned by the agent
    // rather than chosen by the user, so letting it name a second model would swap the
    // backend mid-task - the one case where a swap is nobody's decision. (Subagents can
    // be switched off entirely: they need the `Task` tool, which no TOOL_PROFILE
    // includes, so setting any profile disables them.)
    CLAUDE_CODE_SUBAGENT_MODEL: model.id,

    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.context),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(output),
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    // NOT setting CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, deliberately.
    //
    // It was set to 1 here to keep Claude Code from chattering at Anthropic. It also
    // turns off gateway model discovery, which is what fills the `/model` picker with
    // the catalog: the fetch begins `if (!x7s()) return; if (_a()) return;` and `_a()`
    // is precisely "this variable is set". So the gateway published a catalog of six
    // models over /v1/models and then, in the same breath, told the client not to ask
    // for it - leaving the picker showing only the three tier slots.
    //
    // Proven by removing it: ~/.claude/cache/gateway-models.json appears immediately,
    // tagged baseUrl=http://localhost:8787, holding all six ids.
    //
    // Dropping it costs little here. The discovery request goes to ANTHROPIC_BASE_URL,
    // which is this gateway on loopback - not to Anthropic. Set it yourself if you want
    // the quietest possible client and can live with a three-row picker.
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
