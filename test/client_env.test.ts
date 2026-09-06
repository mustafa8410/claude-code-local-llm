/**
 * client-env contract tests.
 *
 * These variables are how Claude Code names a model, and only ONE of them is set.
 *
 * ANTHROPIC_MODEL carries the primary. The tier and subagent slots are deliberately
 * left unset, so Claude Code fills them with its own Anthropic ids - which this
 * registry never contains, so reuse-primary serves those side tasks from whatever is
 * already loaded and never swaps.
 *
 * Two earlier designs failed. Pinning every slot to one id showed the same model three
 * times in the picker. Giving each tier its own model thrashed an interactive session
 * to a halt, because Claude Code runs titling and compaction's summarising step on the
 * small tier by design. Pinning also cannot survive a model switch: these are static
 * strings, so the tiers keep naming the model that was primary when the config was
 * generated.
 *
 * The picker's real choices come from gateway model DISCOVERY, which lists the whole
 * catalog rather than three of it.
 *
 * The sh/ps1 outputs are EXECUTED by the caller, so their values are quoted as code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.ts";
import { buildClientEnv, shQuote, ps1Quote } from "../src/anthropic/client_env.ts";
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

test("sh and ps1 output quote their values, because the caller executes them", () => {
  // The documented usage is `eval "$(curl ...)"`, so every value emitted here is code.
  // Values were interpolated into `export K="<value>"`, which is not quoting: a double
  // quote ends the string early and `$(...)` or a backtick runs in the user's shell.
  // Reachable, not theoretical - display_name comes from the catalog, and a model added
  // through POST /admin/models carries whatever name the caller supplied.
  const nasty = `x"; touch /tmp/pwned; echo "$(whoami)` + " `id` 'quoted'";
  const shOut = shQuote(nasty);
  const psOut = ps1Quote(nasty);

  // Round-trip through a real shell is the only assertion worth making here.
  const back = execFileSync("bash", ["-c", `printf %s ${shOut}`], { encoding: "utf8" });
  assert.equal(back, nasty, "bash must see the value verbatim, not run any of it");

  // Nothing was created, so no substitution ran.
  assert.ok(!existsSync("/tmp/pwned"), "command substitution must not have executed");

  // PowerShell single-quoting: literal, with '' as the only escape.
  assert.ok(psOut.startsWith("'") && psOut.endsWith("'"));
  assert.ok(!psOut.slice(1, -1).includes("'") || psOut.includes("''"));
});

test("the unset tiers are still labelled, so the picker does not advertise Fable", async () => {
  // Leaving the model vars unset is correct and has a cosmetic cost: those rows then
  // display Claude Code's own names - Fable, Opus, Sonnet - none of which exist here.
  // Picking one silently serves whatever is loaded, so the picker would be offering
  // models the user cannot have. The *_NAME vars are read independently of the model
  // vars, so a label can be supplied without putting side tasks back on the swap path.
  const reg = await registry();
  const { env } = buildClientEnv(reg, CFG, null);

  for (const tier of ["OPUS", "SONNET", "HAIKU"]) {
    assert.match(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] ?? "", /local/i, tier);
    assert.ok(env[`ANTHROPIC_DEFAULT_${tier}_MODEL_DESCRIPTION`], `${tier} needs a description`);
    // The label must not smuggle a model in through the back door.
    assert.equal(env[`ANTHROPIC_DEFAULT_${tier}_MODEL`], undefined);
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
