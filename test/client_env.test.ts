/**
 * client-env contract tests.
 *
 * The pinning invariant is the whole point of this file. Every variable through which
 * Claude Code can name a model must carry the SAME id, because we hold exactly one
 * model in VRAM. Naming a second model in any of them turns that slot into an
 * explicitly-requested id, which chooseTarget honours verbatim - so a side task evicts
 * the main model and the next turn evicts it back, at 10-90s per swap.
 *
 * The assertion is written as a PROPERTY over every *_MODEL key rather than a list of
 * known names, so a variable added later without thinking about this still fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.ts";
import { buildClientEnv } from "../src/anthropic/client_env.ts";
import type { Config } from "../src/config.ts";
import type { HostResources } from "../src/types.ts";

const HOST: HostResources = {
  vramTotalMb: 8191,
  vramFreeMb: 7113,
  ramTotalMb: 15629,
  ramFreeMb: 5000,
};

const CFG: Config = {
  port: 8787,
  host: "0.0.0.0",
  backendPort: 8080,
  serverBin: "llama-server",
  registryPath: "config/models.yaml",
  modelCacheDir: "models",
  idleTtlSeconds: 900,
  keepaliveMs: 10_000,
  streamWatchdogMs: 300_000,
  backgroundStrategy: "reuse-primary",
  backendApiKey: "test",
  requireAuth: false,
  gatewayApiKey: null,
  memoryBudgetGb: null,
  allowCpu: false,
  toolProfile: null,
  captureDir: null,
  logLevel: "info",
};

const CATALOG = `
models:
  - id: local-claude-big
    hf: org/big:Q4_K_M
    size_gb: 1
    context: 16384
    capabilities: [tools]
    tier: vram
    default: true
  - id: local-claude-small
    hf: org/small:Q4_K_M
    size_gb: 1
    context: 32768
    capabilities: [tools]
    tier: vram
`;

async function registry(body = CATALOG): Promise<Registry> {
  const dir = mkdtempSync(path.join(tmpdir(), "cenv-"));
  const file = path.join(dir, "models.yaml");
  writeFileSync(file, body, "utf8");
  return Registry.load(file, HOST);
}

test("every model slot is pinned to the one loaded model", async () => {
  const reg = await registry();
  const { model, env } = buildClientEnv(reg, CFG, null);

  const modelKeys = Object.keys(env).filter((k) => k.endsWith("MODEL"));
  assert.ok(
    modelKeys.length >= 5,
    `expected the tier + subagent slots to be emitted, got ${JSON.stringify(modelKeys)}`,
  );
  for (const key of modelKeys) {
    assert.equal(
      env[key],
      model,
      `${key} must name the loaded model - a second id here makes Claude Code ` +
        `request a swap on every side task`,
    );
  }
});

test("pinning follows the requested model, not just the default", async () => {
  const reg = await registry();
  const { model, env } = buildClientEnv(reg, CFG, "local-claude-small");

  assert.equal(model, "local-claude-small", "an explicit request must be honoured");
  for (const key of Object.keys(env).filter((k) => k.endsWith("MODEL"))) {
    assert.equal(env[key], "local-claude-small", key);
  }
});

test("context and output budgets come from the model, and output leaves prompt room", async () => {
  const reg = await registry();
  const { env } = buildClientEnv(reg, CFG, "local-claude-big");

  const ctx = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  const out = Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);

  assert.equal(ctx, 16384, "must be the catalog's context, not a hardcoded default");
  assert.ok(out > 0 && out < ctx, `output ${out} must fit inside the window ${ctx}`);
  // Claude Code otherwise asks for 32000, which on a local model overflows before a
  // token is generated because prompt and output share this one window.
  assert.ok(out <= ctx / 2, "at least half the window must stay available for the prompt");
});

test("a model without tool support is called out rather than quietly emitted", async () => {
  const reg = await registry(`
models:
  - id: local-claude-notools
    hf: org/x:Q4_K_M
    size_gb: 1
    context: 8192
    capabilities: []
    tier: vram
    default: true
`);
  const { notes } = buildClientEnv(reg, CFG, null);
  assert.ok(
    notes.some((n) => /tool-calling/i.test(n)),
    `expected a tool-support warning, got ${JSON.stringify(notes)}`,
  );
});

test("the pruning warning appears only when the window cannot hold the tool set", async () => {
  // Claude Code 2.1.236 sends ~27,800 tokens of system prompt and tool schemas before
  // the conversation starts. On a 16K model an unpruned session fails on its FIRST
  // message; a 64K model serves it comfortably. Telling a 64K user to prune is stale
  // advice from when the default was 16K, and it costs them tools for nothing.
  const small = await registry(`
models:
  - id: local-claude-tight
    hf: org/x:Q4_K_M
    size_gb: 1
    context: 16384
    capabilities: [tools]
    tier: vram
    default: true
`);
  const tight = buildClientEnv(small, CFG, null).notes;
  assert.ok(
    tight.some((n) => /REQUIRED/.test(n) && /tools/.test(n)),
    `a 16K window must be told pruning is mandatory, got ${JSON.stringify(tight)}`,
  );

  const big = await registry(`
models:
  - id: local-claude-roomy
    hf: org/x:Q4_K_M
    size_gb: 1
    context: 65536
    capabilities: [tools]
    tier: vram
    default: true
`);
  const roomy = buildClientEnv(big, CFG, null).notes;
  assert.ok(
    !roomy.some((n) => /--tools|TOOL_PROFILE/.test(n)),
    `a 64K window must NOT be nagged about pruning, got ${JSON.stringify(roomy)}`,
  );
});
