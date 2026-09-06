/**
 * client-env contract tests.
 *
 * These variables are how Claude Code names a model, and they split by ROLE.
 *
 * Every slot used to carry the same id, because one model is resident and a second id
 * anywhere costs a 10-90s swap. That was true and still wrong: it made `/model` show
 * one name three times, and made the entire swap path unreachable.
 *
 * Giving the tiers a model each was then tried, and reverted, because Claude Code runs
 * side tasks on the small tier by design and an interactive session alternated between
 * two models until requests began failing. So every slot follows the primary again -
 * but for a different reason than before, and with a different way out:
 *
 *   TIER slots     follow the primary. TIER_MODE=distinct opts out.
 *   SUBAGENT slot  follows the primary, always. A subagent is spawned by the agent,
 *                  so a swap there is nobody's decision.
 *   the picker     gets its choices from gateway model DISCOVERY, which lists the
 *                  whole catalog - not from these three variables.
 *
 * That last line is what makes the pinning acceptable now and did not exist before.
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
  tierMode: "follow", tierOpus: null, tierSonnet: null, tierHaiku: null,
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

test("only the main slot names a model; tier and subagent slots are left unset", async () => {
  // This is what keeps side tasks off the swap path, and it has to hold no matter
  // which model is primary.
  //
  // Unset, Claude Code fills these with its own Anthropic ids, which this registry
  // never contains - so titling, compaction's summarising step and subagents all
  // arrive unrecognised and BACKGROUND_STRATEGY=reuse-primary serves them from
  // whatever is loaded. Verified against the container: with the 2B resident, a
  // request for `claude-3-5-haiku-20241022` was answered by the 2B, swap count
  // unmoved.
  //
  // Naming local models here breaks it, because chooseTarget honours a recognised id
  // verbatim - and it breaks worse over time, since these are static strings fixed
  // when the config was generated. Switch model in the picker and the tiers still
  // point at the old one, dragging the backend back on every side task. That was
  // measured as a backend reaching ready and being torn down 17 ms later, repeatedly,
  // with `backend unreachable: fetch failed` in between.
  const reg = await registry();

  for (const requested of [null, "local-claude-small"]) {
    const { model, env } = buildClientEnv(reg, CFG, requested);
    assert.equal(env.ANTHROPIC_MODEL, model, "the main slot IS the primary");
    for (const key of [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      assert.equal(
        env[key], undefined,
        `${key} must stay unset - naming a local model here puts side tasks on the swap path`,
      );
    }
  }
});

test("TIER_MODE=distinct opts back into one model per tier", async () => {
  const reg = await registry();
  const { env } = buildClientEnv(reg, { ...CFG, tierMode: "distinct" }, null);

  const tiers = [env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL];
  assert.ok(new Set(tiers).size > 1, `distinct must actually differ: ${JSON.stringify(tiers)}`);

  // Biggest to Opus, smallest to Haiku - what those names mean to anyone who has used
  // the hosted models.
  const sizeOf = (id: string): number => reg.list().find((m) => m.id === id)!.size_gb;
  assert.ok(
    sizeOf(env.ANTHROPIC_DEFAULT_OPUS_MODEL!) >= sizeOf(env.ANTHROPIC_DEFAULT_HAIKU_MODEL!),
    "Opus must not be smaller than Haiku",
  );
  assert.ok(env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION?.includes("GB"));
});

test("the emitted config does not switch off model discovery", async () => {
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 used to be emitted here to keep the
  // client quiet. It also gates gateway model discovery - the fetch opens with
  // `if (_a()) return`, and _a() is exactly "that variable is set" - so the gateway
  // served a six-model catalog on /v1/models and told the client not to ask for it.
  // The `/model` picker was stuck on the three tier rows as a result.
  //
  // Proven by removing it: gateway-models.json appears at once with all six ids.
  const reg = await registry();
  const { env } = buildClientEnv(reg, CFG, null);
  assert.equal(
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    undefined,
    "setting this silently empties the /model picker",
  );
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1", "and this enables it");
});

test("TIER_* overrides the automatic pick", async () => {
  const reg = await registry();
  const pinned = { ...CFG, tierOpus: "local-claude-small", tierHaiku: "local-claude-small" };
  const { env } = buildClientEnv(reg, pinned, null);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "local-claude-small");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "local-claude-small");
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
