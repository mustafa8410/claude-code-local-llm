/**
 * Effort hysteresis.
 *
 * A soak run against the container produced 36 effort changes and 35 backend reloads in
 * a single phase, because requests alternated between two levels and every alternation
 * forced a respawn. The phase burned 537 seconds and produced no files. These tests pin
 * the guard that makes that impossible.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.ts";
import { RequestContext } from "../src/context.ts";
import { normaliseError } from "../src/anthropic/messages.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { HostResources, MessagesRequest } from "../src/types.ts";

const HOST: HostResources = {
  vramTotalMb: 8191,
  vramFreeMb: 7113,
  ramTotalMb: 15629,
  ramFreeMb: 5000,
};

const CATALOG = `
models:
  - id: local-claude-thinker
    hf: org/repo:Q4_K_M
    size_gb: 1
    context: 16384
    capabilities: [tools, thinking]
    tier: vram
    default: true
`;

function cfg(over: Partial<Config> = {}): Config {
  return {
    port: 8787, host: "0.0.0.0", backendPort: 8080, serverBin: "llama-server",
    registryPath: "config/models.yaml", modelCacheDir: "models",
    idleTtlSeconds: 900, keepaliveMs: 10_000, streamWatchdogMs: 300_000,
    backgroundStrategy: "reuse-primary", backendApiKey: "k",
    requireAuth: false, gatewayApiKey: null, memoryBudgetGb: null, allowCpu: false,
    reasoningBudget: null, effortFollowsClient: true, effortStreak: 3,
    tierMode: "follow", tierOpus: null, tierSonnet: null, tierHaiku: null,
    toolProfile: null, captureDir: null, logLevel: "error",
    ...over,
  };
}

/** A supervisor stub that records how many times the backend was evicted. */
function fakeSupervisor(loadedId: string | null) {
  let stops = 0;
  return {
    stops: () => stops,
    currentModelId: () => loadedId,
    stop: async () => { stops += 1; },
  };
}

async function registry(): Promise<Registry> {
  const dir = mkdtempSync(path.join(tmpdir(), "eff-"));
  const file = path.join(dir, "models.yaml");
  writeFileSync(file, CATALOG, "utf8");
  return Registry.load(file, HOST);
}

const body = (effort: string): MessagesRequest =>
  ({ model: "local-claude-thinker", messages: [], output_config: { effort } }) as MessagesRequest;

test("an alternating effort level never triggers a reload", async () => {
  // The exact pattern measured in the soak: two levels, strictly alternating.
  const reg = await registry();
  const sup = fakeSupervisor("local-claude-thinker");
  const ctx = new RequestContext(cfg(), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;
  const before = model.reasoningBudget;

  for (let i = 0; i < 20; i++) {
    await ctx.applyClientEffort(model, body(i % 2 === 0 ? "max" : "high"));
  }

  assert.equal(sup.stops(), 0, "20 alternating requests must not evict the backend once");
  assert.equal(model.reasoningBudget, before, "and must not move the budget");
});

test("a level that actually holds is applied, once", async () => {
  const reg = await registry();
  const sup = fakeSupervisor("local-claude-thinker");
  const ctx = new RequestContext(cfg(), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;

  for (let i = 0; i < 6; i++) await ctx.applyClientEffort(model, body("max"));

  assert.equal(model.reasoningBudget, 8192, "max reaches the ceiling of a 16K window");
  assert.equal(sup.stops(), 1, "applied exactly once, not once per request");
});

test("the run must be consecutive, not merely frequent", async () => {
  const reg = await registry();
  const sup = fakeSupervisor("local-claude-thinker");
  const ctx = new RequestContext(cfg(), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;

  // "max" appears more often than "low", but never three times in a row.
  for (const e of ["max", "max", "low", "max", "max", "low", "max", "max"]) {
    await ctx.applyClientEffort(model, body(e));
  }
  assert.equal(sup.stops(), 0);
});

test("the untouched dial costs nothing - the property the default rests on", async () => {
  // Claude Code sends effort=high whenever the user has expressed no preference, and
  // the ladder anchors `high` on the model's own default. That equality is the entire
  // justification for shipping this enabled: someone who never sets
  // CLAUDE_CODE_EFFORT_LEVEL must pay no reloads at all. Measured over a real
  // twelve-request session: 12x high, 0 budget changes, 1 spawn. If this assertion ever
  // fails, the default has to go back to off.
  const reg = await registry();
  const sup = fakeSupervisor("local-claude-thinker");
  const ctx = new RequestContext(cfg(), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;
  const before = model.reasoningBudget;

  for (let i = 0; i < 12; i++) await ctx.applyClientEffort(model, body("high"));

  assert.equal(model.reasoningBudget, before, "high must equal the model's own default");
  assert.equal(sup.stops(), 0, "an untouched dial must never evict the backend");
});

test("the feature defaults to enabled", () => {
  // Guards the flip itself: loadConfig with a clean environment must opt in.
  const saved = process.env.EFFORT_FOLLOWS_CLIENT;
  delete process.env.EFFORT_FOLLOWS_CLIENT;
  try {
    assert.equal(loadConfig().effortFollowsClient, true);
  } finally {
    if (saved === undefined) delete process.env.EFFORT_FOLLOWS_CLIENT;
    else process.env.EFFORT_FOLLOWS_CLIENT = saved;
  }
});

test("by default the user's level applies on the FIRST request carrying it", async () => {
  // The point of the default. A streak of 3 served two requests at a budget the user
  // had not asked for and did not save a reload - someone who exports
  // CLAUDE_CODE_EFFORT_LEVEL sends the same level every time, so the reload was merely
  // postponed to the third request. Anyone who genuinely meets an alternating client
  // can still raise EFFORT_STREAK.
  const saved = process.env.EFFORT_STREAK;
  delete process.env.EFFORT_STREAK;
  try {
    assert.equal(loadConfig().effortStreak, 1, "no waiting by default");
  } finally {
    if (saved === undefined) delete process.env.EFFORT_STREAK;
    else process.env.EFFORT_STREAK = saved;
  }

  const reg = await registry();
  const sup = fakeSupervisor("local-claude-thinker");
  const ctx = new RequestContext(cfg({ effortStreak: 1 }), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;
  const before = model.reasoningBudget;

  await ctx.applyClientEffort(model, body("max"));
  assert.notEqual(model.reasoningBudget, before, "honoured immediately, not on request 3");
  assert.equal(model.reasoningBudget, 8192);
  assert.equal(sup.stops(), 1, "and the reload is paid once, up front");

  // Still exactly once for the rest of the session - the level has not changed.
  for (let i = 0; i < 5; i++) await ctx.applyClientEffort(model, body("max"));
  assert.equal(sup.stops(), 1, "a steady level costs nothing after the first request");
});

test("nothing happens at all when the feature is off", async () => {
  const reg = await registry();
  const sup = fakeSupervisor("local-claude-thinker");
  const ctx = new RequestContext(cfg({ effortFollowsClient: false }), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;
  const before = model.reasoningBudget;

  for (let i = 0; i < 10; i++) await ctx.applyClientEffort(model, body("max"));

  assert.equal(sup.stops(), 0);
  assert.equal(model.reasoningBudget, before);
});

test("an upstream context-overflow becomes the wording Claude Code recovers from", () => {
  // Measured against the container: llama-server rejected a 20833-token prompt on a
  // 16384-token window, and the raw error reached the client wrapped as api_error -
  // reading as a gateway fault rather than a prompt that needs compacting.
  const upstream = JSON.stringify({
    error: {
      code: 400,
      message: "request (20833 tokens) exceeds the available context size (16384 tokens), try increasing it",
      type: "exceed_context_size_error",
      n_prompt_tokens: 20833,
      n_ctx: 16384,
    },
  });

  const out = JSON.parse(normaliseError(upstream)) as {
    type: string;
    error: { type: string; message: string };
  };
  assert.equal(out.type, "error");
  assert.equal(out.error.type, "invalid_request_error", "not a server fault");
  assert.match(out.error.message, /prompt is too long/i, "the wording is load-bearing");
  assert.match(out.error.message, /20833 tokens > 16384 maximum/);
});

test("an already Anthropic-shaped upstream error is passed through untouched", () => {
  // Claude Code's retry logic matches on upstream wording, so re-wrapping breaks it.
  const shaped = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  });
  assert.equal(normaliseError(shaped), shaped);
});

test("a model that is not loaded changes budget without an eviction", async () => {
  const reg = await registry();
  const sup = fakeSupervisor(null); // nothing serving
  const ctx = new RequestContext(cfg(), reg, sup as never, HOST);
  const model = reg.get("local-claude-thinker")!;

  for (let i = 0; i < 4; i++) await ctx.applyClientEffort(model, body("low"));

  assert.equal(model.reasoningBudget, 512, "the next load will pick it up");
  assert.equal(sup.stops(), 0, "no backend to evict, so no reload cost");
});
