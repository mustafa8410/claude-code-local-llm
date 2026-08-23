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
 */

import type { ServerResponse } from "node:http";
import type { Registry } from "../registry.ts";
import type { Config } from "../config.ts";

/** Fraction of the window handed to output; the rest is prompt headroom. */
const OUTPUT_SHARE = 0.25;
const MIN_OUTPUT = 1024;

export function buildClientEnv(
  registry: Registry,
  cfg: Config,
  requestedId: string | null,
): { model: string; env: Record<string, string>; notes: string[] } {
  const { model } = registry.resolve(requestedId ?? undefined);
  const output = Math.max(MIN_OUTPUT, Math.floor(model.context * OUTPUT_SHARE));

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: "http://localhost:" + cfg.port,
    ANTHROPIC_AUTH_TOKEN: "local-gateway",
    ANTHROPIC_MODEL: model.id,
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
  notes.push(
    "Launch with a reduced tool set - tool schemas were measured at 81% of a Claude " +
      "Code request: claude --tools \"Read,Edit,Grep,Glob,Bash\"",
  );
  if (!model.available) {
    notes.push("WARNING: " + model.id + " is unavailable: " + (model.unavailableReason ?? ""));
  }
  return { model: model.id, env, notes };
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
