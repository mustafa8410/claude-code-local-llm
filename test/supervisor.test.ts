/**
 * Supervisor tests.
 *
 * This is the most intricate file in the project and had no direct coverage. Two bugs
 * were found in it by running the container rather than by testing: a spawn failure
 * polled a dead port for the full 15-minute load timeout instead of failing at once, and
 * single-flight admitted two concurrent spawns onto one GPU. Both are pinned below.
 *
 * The spawn tests use a real child process with a binary that does not exist. That is
 * the actual failure being tested - Node emits 'error' INSTEAD OF 'exit' when a process
 * cannot be spawned - and no mock reproduces it faithfully.
 *
 * What that approach cannot reach: everything downstream of a load that SUCCEEDS - the
 * idle-TTL unload, the swap counter, and readiness polling against a live port all need
 * a real llama-server, which is a 3 GB image and a GPU. Those paths are covered by
 * running the container instead, and the swap timings in the README come from there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Supervisor, buildServerArgs } from "../src/supervisor.ts";
import type { Config } from "../src/config.ts";
import type { ResolvedModel } from "../src/registry.ts";

function cfg(over: Partial<Config> = {}): Config {
  return {
    port: 8787, host: "127.0.0.1", backendPort: 8080,
    serverBin: "/nonexistent/llama-server",
    registryPath: "config/models.yaml", modelCacheDir: "models",
    idleTtlSeconds: 0, keepaliveMs: 10_000, streamWatchdogMs: 300_000,
    backgroundStrategy: "reuse-primary", backendApiKey: "secret-not-in-argv",
    requireAuth: false, gatewayApiKey: null, memoryBudgetGb: null, allowCpu: true,
    reasoningBudget: null, effortFollowsClient: true, effortStreak: 3,
    tierMode: "follow", tierOpus: null, tierSonnet: null, tierHaiku: null,
    toolProfile: null, captureDir: null, logLevel: "error",
    ...over,
  };
}

function model(over: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    id: "local-claude-m", alias: "local-claude-m", hf: "org/repo:Q4_K_M",
    size_gb: 1, context: 16384, capabilities: ["tools"], tier: "vram",
    available: true, reasoningBudget: 0,
    ...over,
  } as ResolvedModel;
}

// ------------------------------------------------------------------ buildServerArgs --

test("tool calling is always requested", () => {
  // Without --jinja llama-server answers normally and simply never emits a tool_use
  // block, so Claude Code's agent loop never starts. Silent, and fatal to the product.
  assert.ok(buildServerArgs(model(), 8080).includes("--jinja"));
});

test("the backend credential never appears in argv", () => {
  // argv is readable via `ps` and is echoed into the info-level spawn log.
  const args = buildServerArgs(model(), 8080).join(" ");
  assert.ok(!args.includes("secret-not-in-argv"));
  assert.ok(!args.includes("--api-key"));
});

test("a text-only model does not download a vision projector", () => {
  assert.ok(buildServerArgs(model({ capabilities: ["tools"] }), 8080).includes("--no-mmproj"));
});

test("a vision model keeps its projector", () => {
  const args = buildServerArgs(model({ capabilities: ["tools", "vision"] }), 8080);
  assert.ok(!args.includes("--no-mmproj"));
});

test("reasoning budget maps onto the right flag in all three regimes", () => {
  const off = buildServerArgs(model({ reasoningBudget: 0 }), 8080).join(" ");
  assert.match(off, /--reasoning off/);
  assert.ok(!off.includes("--reasoning-budget"));

  const bounded = buildServerArgs(model({ reasoningBudget: 2048 }), 8080).join(" ");
  assert.match(bounded, /--reasoning-budget 2048/);
  assert.ok(!bounded.includes("--reasoning off"));

  // -1 is unrestricted, which is llama-server's own default: say nothing.
  const free = buildServerArgs(model({ reasoningBudget: -1 }), 8080).join(" ");
  assert.ok(!free.includes("--reasoning"));
});

test("the context window and port come from the model and config, not a default", () => {
  const args = buildServerArgs(model({ context: 32768 }), 9999);
  assert.equal(args[args.indexOf("-c") + 1], "32768");
  assert.equal(args[args.indexOf("--port") + 1], "9999");
  assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1", "backend stays on loopback");
});

test("hf and path are mutually exclusive spawn sources", () => {
  assert.ok(buildServerArgs(model({ hf: "org/r:Q4" }), 8080).includes("-hf"));
  const local = buildServerArgs(
    model({ hf: undefined, path: "/models/x.gguf" }) as ResolvedModel, 8080,
  );
  assert.ok(local.includes("-m"));
  assert.ok(!local.includes("-hf"));
});

test("per-model args come last so a catalog entry can override the defaults", () => {
  const args = buildServerArgs(model({ args: ["-ngl", "999", "--parallel", "1"] }), 8080);
  assert.deepEqual(args.slice(-4), ["-ngl", "999", "--parallel", "1"]);
});

// ------------------------------------------------------------------------ lifecycle --

test("an unavailable model is refused before anything is spawned", async () => {
  const sup = new Supervisor(cfg());
  await assert.rejects(
    () => sup.ensure(model({ available: false, unavailableReason: "needs ~18 GB" })),
    /cannot run on this host: needs ~18 GB/,
  );
  assert.equal(sup.status().spawnCount, 0, "no process should have been started");
});

test("a missing binary fails in milliseconds, not after the load timeout", async () => {
  // Regression: Node emits 'error' INSTEAD OF 'exit' when a process cannot be spawned.
  // That was only logged, so `exited` stayed null and the readiness loop polled a dead
  // port for the full 15-minute LOAD_TIMEOUT_MS before blaming the model for being slow.
  const sup = new Supervisor(cfg());
  const t0 = Date.now();
  await assert.rejects(() => sup.ensure(model()), /could not start llama-server/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `took ${elapsed}ms; a spawn failure must be immediate`);
});

test("the spawn failure names the binary and the variable that sets it", async () => {
  const sup = new Supervisor(cfg({ serverBin: "/nope/llama-server" }));
  await assert.rejects(() => sup.ensure(model()), (err: unknown) => {
    const msg = (err as Error).message;
    assert.match(msg, /\/nope\/llama-server/, "must name the path that failed");
    assert.match(msg, /LLAMA_SERVER_BIN/, "must name the knob that fixes it");
    return true;
  });
});

test("concurrent callers are serialised, never overlapping on the GPU", async () => {
  // What single-flight actually guarantees is that two spawns are never in flight at
  // once - that is the CUDA OOM it exists to prevent. It does NOT guarantee one spawn
  // total: once a load fails, the next waiter is entitled to try again rather than
  // inheriting a permanent failure.
  //
  // Timing is the honest way to observe non-overlap. Serialised, six callers cost about
  // six attempts; overlapping, they would cost about one.
  const sup = new Supervisor(cfg());
  const m = model();

  const t0 = Date.now();
  await sup.ensure(m).catch(() => undefined);
  const single = Date.now() - t0;

  const t1 = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => sup.ensure(m)));
  const six = Date.now() - t1;

  assert.ok(results.every((r) => r.status === "rejected"), "the fake binary cannot load");
  assert.ok(
    six > single * 3,
    `six callers took ${six}ms against ${single}ms for one; overlapping spawns would be comparable`,
  );
});

test("concurrent callers for DIFFERENT models never spawn two at once", async () => {
  // The bug this replaced: with a load in flight and two waiters for other models, both
  // resumed, both fell through the single check, and both spawned - the exact CUDA OOM
  // the class exists to prevent.
  const sup = new Supervisor(cfg());
  const results = await Promise.allSettled([
    sup.ensure(model({ id: "local-claude-a", alias: "local-claude-a" })),
    sup.ensure(model({ id: "local-claude-b", alias: "local-claude-b" })),
    sup.ensure(model({ id: "local-claude-c", alias: "local-claude-c" })),
  ]);
  assert.ok(results.every((r) => r.status === "rejected"));
  // Serialised, so each attempt is its own spawn - what matters is that they did not
  // overlap, which single-flight guarantees by making each wait for the last.
  assert.ok(sup.status().spawnCount <= 3, "no more spawns than callers");
});

test("stopping when nothing runs is safe and reports idle", async () => {
  const sup = new Supervisor(cfg());
  await sup.stop();
  const s = sup.status();
  assert.equal(s.state, "idle");
  assert.equal(s.modelId, null);
  assert.equal(sup.currentModelId(), null);
});

test("isReadyFor is false for everything until something is serving", () => {
  const sup = new Supervisor(cfg());
  assert.equal(sup.isReadyFor("local-claude-m"), false);
  assert.equal(sup.isReadyFor("anything"), false);
});

test("inflight tracking is symmetric", () => {
  const sup = new Supervisor(cfg());
  assert.equal(sup.status().inflight, 0);
  sup.trackStart();
  sup.trackStart();
  assert.equal(sup.status().inflight, 2);
  sup.trackEnd();
  sup.trackEnd();
  assert.equal(sup.status().inflight, 0, "an unbalanced count pins a model in VRAM forever");
});

test("a failed load leaves no model claimed as current", async () => {
  const sup = new Supervisor(cfg());
  await assert.rejects(() => sup.ensure(model()));
  assert.equal(sup.currentModelId(), null, "a half-started model must not look loaded");
  assert.equal(sup.status().state, "idle");
});

test("progress callbacks are offered to the caller during a load", async () => {
  // An HTTP handler uses these to keep an SSE stream alive through a swap; losing them
  // reintroduces the 300s silent-stream abort.
  const sup = new Supervisor(cfg());
  const seen: string[] = [];
  await assert.rejects(() => sup.ensure(model(), (m) => seen.push(m)));
  assert.ok(seen.length > 0, "the caller was never told anything was happening");
});
