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
 * ONLY ANTHROPIC_MODEL NAMES A MODEL. The tier and subagent slots are deliberately
 * left unset so Claude Code fills them with its own ids, which this registry never
 * contains - which is what keeps side tasks off the swap path. See pickTiers.
 *
 * THE SH AND PS1 OUTPUTS ARE EXECUTED by the caller, so every value in them is code.
 * See shQuote/ps1Quote before adding a field.
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
 * So by default the tier slots are not emitted at all. Claude Code then fills them with
 * its own Anthropic ids, this registry does not recognise those, and reuse-primary
 * serves them from whatever is loaded without swapping - which also survives the user
 * switching model, where a pinned local id would not, because these are static strings
 * fixed when the config was generated. The picker gets its real choices from gateway
 * model discovery, which lists the whole catalog.
 *
 * TIER_MODE=distinct calls this and emits explicit slots for anyone who wants them;
 * TIER_OPUS/SONNET/HAIKU pin individual ones.
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

/**
 * Quote a value for `eval`, and for `Invoke-Expression`.
 *
 * These outputs are designed to be EXECUTED - the documented usage is
 * `eval "$(curl ...)"` - so anything interpolated into them is code. They were built by
 * wrapping values in double quotes, which is not quoting at all: a value containing a
 * double quote breaks out of the string, and one containing `$(...)` or a backtick runs
 * as a command in the user's shell.
 *
 * That is reachable, not theoretical. Values include `display_name` from the catalog,
 * and a model added at runtime through POST /admin/models carries whatever name the
 * caller chose. Found because a description of mine contained quotes and produced
 * visibly broken output; the injection was the same bug wearing a hat.
 *
 * Single quotes are literal in both shells. Neither lets you escape the quote character
 * inside them, so both use the standard trick of closing, emitting one, and reopening.
 */
export function shQuote(v: string): string {
  return "'" + v.replace(/'/g, `'\\''`) + "'";
}

export function ps1Quote(v: string): string {
  return "'" + v.replace(/'/g, "''") + "'";
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

  const byId = (id: string): ResolvedModel | undefined => all.find((m) => m.id === id);

  // Only name a model in a tier slot when someone has asked for that explicitly.
  // Leaving them unset is what keeps side tasks on the loaded model; see the block
  // where these are spread into env.
  const tierEnv: Record<string, string> = {};
  if (cfg.tierMode === "distinct" || cfg.tierOpus || cfg.tierSonnet || cfg.tierHaiku) {
    const auto = cfg.tierMode === "distinct"
      ? pickTiers(all, model.id)
      : { opus: model.id, sonnet: model.id, haiku: model.id };
    const tiers = {
      opus: cfg.tierOpus ?? auto.opus,
      sonnet: cfg.tierSonnet ?? auto.sonnet,
      haiku: cfg.tierHaiku ?? auto.haiku,
    };
    tierEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = tiers.opus;
    tierEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = tiers.sonnet;
    tierEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = tiers.haiku;
    tierEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = tiers.opus;
    tierEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = tiers.sonnet;
    tierEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = tiers.haiku;
    tierEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION = tierNote(byId(tiers.opus), "best quality");
    tierEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = tierNote(byId(tiers.sonnet), "balanced");
    tierEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION = tierNote(byId(tiers.haiku), "fastest");
  } else {
    // The slots stay unset - that is the whole point - but their LABELS do not have to.
    // Claude Code reads `ANTHROPIC_DEFAULT_<tier>_MODEL_NAME ?? <the model id>`, so a
    // name can be supplied without naming a model and putting side tasks back on the
    // swap path.
    //
    // Worth doing because the alternative is worse than a duplicate: unlabelled, these
    // rows show Claude Code's own model names - Fable, Opus, Sonnet - which do not
    // exist on this gateway. Picking one silently serves whatever is loaded, so the
    // picker would be advertising models the user cannot actually have.
    const routed = "(local - whichever model is loaded)";
    const explain = "not a separate model - pick one from the gateway list below";
    for (const tier of ["OPUS", "SONNET", "HAIKU"]) {
      tierEnv["ANTHROPIC_DEFAULT_" + tier + "_MODEL_NAME"] = routed;
      tierEnv["ANTHROPIC_DEFAULT_" + tier + "_MODEL_DESCRIPTION"] = explain;
    }
  }

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "http://localhost:" + cfg.port,
    // The real secret when one is configured, so the emitted block actually works.
    // Claude Code sends this as `Authorization: Bearer`; with auth off, any non-empty
    // placeholder is fine and the gateway ignores it.
    ANTHROPIC_AUTH_TOKEN: cfg.gatewayApiKey ?? "local-gateway",

    // The model a request goes to when nothing else names one.
    ANTHROPIC_MODEL: model.id,

    // THE TIER AND SUBAGENT SLOTS ARE DELIBERATELY LEFT UNSET. See TIER SLOTS above.
    //
    // Left alone, Claude Code fills them with its own Anthropic ids, which this
    // registry never contains. That makes every side task - titling, compaction's
    // summarising step, subagents - arrive as an id we do not recognise, which is
    // exactly the case BACKGROUND_STRATEGY=reuse-primary was written for: it serves
    // them from whatever is already loaded and never swaps. Verified directly: with the
    // 2B resident, a request for `claude-3-5-haiku-20241022` was answered by the 2B
    // with the swap counter unmoved.
    //
    // Naming local models here breaks that, because chooseTarget honours a recognised
    // id verbatim - and it breaks it in a way that gets worse when you switch models,
    // since these are static strings fixed when the config was generated. Pick a
    // different model from the picker and the tiers still point at the old one, so
    // every side task drags the backend back.
    //
    // The id space does the work instead: a LOCAL id means you chose it and a swap is
    // right; an ANTHROPIC id means the agent did, and it is served from what is loaded.
    ...tierEnv,

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
    for (const note of notes) lines.push("# " + note.replace(/\r?\n/g, " "));
    for (const [k, v] of Object.entries(env)) {
      lines.push(format === "ps1" ? `$env:${k} = ${ps1Quote(v)}` : `export ${k}=${shQuote(v)}`);
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(lines.join("\n") + "\n");
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model, env, notes }, null, 2));
}
