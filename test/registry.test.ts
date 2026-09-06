/**
 * Registry validation tests.
 *
 * These cover the two silent-failure rules that model ids must satisfy at once.
 * Both were discovered the hard way; a wrong id produces no error at runtime, just
 * a model that never appears in /model or a session that never compacts in time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Registry, defaultReasoningBudget, reasoningRange, budgetForEffort } from "../src/registry.ts";
import { pruneTools, isKnownProfile, describeProfiles } from "../src/tools/prune.ts";
import { readEffort } from "../src/types.ts";
import type { HostResources, ToolDef } from "../src/types.ts";

const HOST: HostResources = {
  vramTotalMb: 8191,
  vramFreeMb: 7113,
  ramTotalMb: 15629,
  ramFreeMb: 5000,
};

function writeRegistry(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reg-"));
  const file = path.join(dir, "models.yaml");
  writeFileSync(file, body, "utf8");
  return file;
}

const VALID = `
models:
  - id: local-claude-test
    hf: org/repo:Q4_K_M
    size_gb: 1
    context: 8192
    capabilities: [tools]
    tier: vram
    default: true
`;

test("accepts a conforming registry", async () => {
  const reg = await Registry.load(writeRegistry(VALID), HOST);
  assert.equal(reg.getDefaultId(), "local-claude-test");
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0]!.available, true);
});

test("rejects an id without claude or anthropic", async () => {
  const file = writeRegistry(VALID.replace("local-claude-test", "qwen-9b"));
  await assert.rejects(
    () => Registry.load(file, HOST),
    /must contain "claude" or "anthropic"/,
  );
});

test("rejects an id starting with claude-", async () => {
  // Such an id passes discovery but makes CLAUDE_CODE_MAX_CONTEXT_TOKENS inert,
  // so Claude Code assumes a 200K window for a 16K model.
  const file = writeRegistry(VALID.replace("local-claude-test", "claude-qwen-9b"));
  await assert.rejects(() => Registry.load(file, HOST), /must not START with "claude-"/);
});

test("rejects an id containing [1m]", async () => {
  const file = writeRegistry(VALID.replace("local-claude-test", "local-claude-x[1m]"));
  await assert.rejects(() => Registry.load(file, HOST), /\[1m\]/);
});

test("rejects two models both marked default", async () => {
  const file = writeRegistry(`
models:
  - id: local-claude-a
    hf: o/r:Q4
    size_gb: 1
    context: 8192
    capabilities: [tools]
    tier: vram
    default: true
  - id: local-claude-b
    hf: o/r:Q4
    size_gb: 1
    context: 8192
    capabilities: [tools]
    tier: vram
    default: true
`);
  await assert.rejects(() => Registry.load(file, HOST), /more than one model marked/);
});

test("marks a model that cannot fit unavailable, naming the shortfall", async () => {
  const file = writeRegistry(VALID.replace("size_gb: 1", "size_gb: 400"));
  const reg = await Registry.load(file, HOST);
  const m = reg.list()[0]!;
  assert.equal(m.available, false);
  assert.match(m.unavailableReason ?? "", /GB/);
});

test("an unknown model id falls back to the default rather than 404ing", async () => {
  // This is what makes `ANTHROPIC_BASE_URL=... claude` work with no other config:
  // Claude Code sends real Anthropic ids that a local catalog never contains.
  const reg = await Registry.load(writeRegistry(VALID), HOST);
  const { model, fellBack } = reg.resolve("claude-sonnet-4-5");
  assert.equal(model.id, "local-claude-test");
  assert.equal(fellBack, true);

  const exact = reg.resolve("local-claude-test");
  assert.equal(exact.fellBack, false);
});

test("tool pruning is deterministic and order-preserving", () => {
  // Reordering between requests would break the llama.cpp prompt cache, which is the
  // very thing pruning exists to protect.
  const tools: ToolDef[] = [
    { name: "Read" },
    { name: "WebFetch" },
    { name: "Grep" },
    { name: "Write" },
    { name: "Bash" },
  ];
  const a = pruneTools(tools, "analysis")!.map((t) => t.name);
  const b = pruneTools(tools, "analysis")!.map((t) => t.name);
  assert.deepEqual(a, b, "same input must give the same output");
  assert.deepEqual(a, ["Read", "Grep", "Bash"], "input order preserved");
  assert.ok(!a.includes("Write"), "analysis profile excludes Write");

  assert.equal(pruneTools(tools, "full")!.length, 5);
  assert.deepEqual(
    pruneTools(tools, "Read,Bash")!.map((t) => t.name),
    ["Read", "Bash"],
  );
});

test("an unrecognised TOOL_PROFILE is detectable instead of silently doing nothing", () => {
  // This was a silent no-op: `TOOL_PROFILE=codng` resolved to null, pruneTools handed
  // the tools back untouched, and nothing anywhere said so. On a window too small for
  // the full tool set it surfaced much later as `prompt is too long`, which points at
  // the model rather than at the typo. server.ts now warns and falls back on this.
  assert.equal(isKnownProfile("coding"), true);
  assert.equal(isKnownProfile("analysis"), true);
  assert.equal(isKnownProfile("full"), true);
  assert.equal(isKnownProfile("Read,Edit,Grep,Glob,Bash"), true, "a list is valid");
  assert.equal(isKnownProfile("READ,BASH"), true, "and case does not matter");

  assert.equal(isKnownProfile("codng"), false, "a typo must be caught");
  assert.equal(isKnownProfile("analsis"), false);

  // A bare word is read as a profile name, never as a one-tool list: treating "Read"
  // as a list would prune every other tool away, which is a worse outcome for what is
  // far more likely a mistyped profile.
  assert.equal(isKnownProfile("Read"), false);
});

test("the named profiles are exactly what the docs claim", () => {
  // The README lists these members; drift between the two is how someone picks a
  // profile that silently lacks the tool they needed.
  const p = describeProfiles();
  assert.deepEqual([...p.analysis!], ["read", "glob", "grep", "bash", "powershell", "todowrite"]);
  assert.ok(p.coding!.includes("write") && p.coding!.includes("edit"));
  assert.ok(!p.analysis!.includes("write"), "analysis stays read-only");
});

test("the catalog default is skipped when it cannot run on this host", async () => {
  // Regression: the default was `models.find(m => m.default)` with no availability
  // test, so a constrained host kept a model that could never load as the answer to
  // every unrecognised id - and Claude Code's background slot sends an unrecognised id
  // on every side task. A session spent itself on 400s naming a model that was never
  // going to run, on a host that had two perfectly good alternatives.
  const file = writeRegistry(`
models:
  - id: local-claude-huge
    hf: o/r:Q4
    size_gb: 400
    context: 8192
    capabilities: [tools]
    tier: vram
    default: true
  - id: local-claude-small
    hf: o/r:Q4
    size_gb: 1
    context: 8192
    capabilities: [tools]
    tier: vram
  - id: local-claude-medium
    hf: o/r:Q4
    size_gb: 4
    context: 8192
    capabilities: [tools]
    tier: vram
`);
  const reg = await Registry.load(file, HOST);

  assert.equal(
    reg.getDefaultId(),
    "local-claude-medium",
    "the largest model that fits, not merely the first one in file order",
  );
  assert.equal(
    reg.getMarkedDefaultId(),
    "local-claude-huge",
    "the catalog's own marking stays reportable so the swap can be logged",
  );
  assert.equal(reg.resolve("claude-sonnet-4-5").model.id, "local-claude-medium");
});

test("a default that fits is left exactly as the catalog asked", async () => {
  const reg = await Registry.load(writeRegistry(VALID), HOST);
  assert.equal(reg.getDefaultId(), "local-claude-test");
  assert.equal(reg.getMarkedDefaultId(), "local-claude-test");
});

test("when nothing fits, a default still resolves so endpoints can explain why", async () => {
  // Returning null here would make /v1/models and /admin/client-env throw instead of
  // reporting the shortfall, which is the one thing a user in this state needs.
  const reg = await Registry.load(writeRegistry(VALID.replace("size_gb: 1", "size_gb: 400")), HOST);
  assert.equal(reg.getDefaultId(), "local-claude-test");
  assert.ok(reg.list().every((m) => !m.available));
});

// ---------------------------------------------------------------- reasoning ----
//
// A thinking model spends its chain of thought from the same window as the prompt and
// the reply. Unbounded on a local model that is not "higher quality", it is a request
// that comes back with the whole output budget spent thinking and no answer - measured
// in a container: 64 output tokens, all thinking, zero text.

const THINKS = { capabilities: ["tools", "thinking"], context: 16384 } as const;

test("a thinking model gets a budget that leaves room to answer", () => {
  const budget = defaultReasoningBudget({ ...THINKS } as never);
  assert.equal(budget, 2048, "an eighth of the window");
  assert.ok(budget < 16384 / 2, "must stay under the enforced ceiling");
});

test("a large window does not reserve an unbounded amount of thinking", () => {
  assert.equal(
    defaultReasoningBudget({ capabilities: ["thinking"], context: 131072 } as never),
    4096,
    "capped rather than scaling forever",
  );
});

test("a model with no thinking mode gets no budget", () => {
  assert.equal(
    defaultReasoningBudget({ capabilities: ["tools"], context: 32768 } as never),
    0,
  );
});

test("the allowed ceiling is half the window", () => {
  assert.deepEqual(reasoningRange({ context: 16384 } as never), { min: -1, max: 8192 });
});

test("a budget outside the allowed range is refused, naming the range", async () => {
  const reg = await Registry.load(writeRegistry(VALID), HOST);
  // VALID has context 8192, so the ceiling is 4096.
  assert.throws(
    () => reg.setReasoningBudget("local-claude-test", 99_999),
    /between -1 and 4096/,
  );
  assert.throws(() => reg.setReasoningBudget("local-claude-test", -2), /between/);
});

test("a budget above 0 is refused for a model with no thinking mode", async () => {
  // Silently accepting it would report a setting that the chat template ignores.
  const reg = await Registry.load(writeRegistry(VALID), HOST);
  assert.throws(() => reg.setReasoningBudget("local-claude-test", 512), /no thinking mode/);
  assert.equal(reg.setReasoningBudget("local-claude-test", 0).reasoningBudget, 0);
});

test("effort maps onto the budget ladder, anchored so `high` changes nothing", () => {
  // Claude Code sends output_config.effort on every request and defaults it to "high",
  // so "high" must land exactly where the model would have been anyway - otherwise
  // merely enabling the feature would silently re-budget every model.
  const m = { capabilities: ["tools", "thinking"], context: 16384 } as never;
  assert.equal(budgetForEffort(m, "high"), defaultReasoningBudget(m));

  assert.deepEqual(
    (["low", "medium", "high", "xhigh", "max"] as const).map((e) => budgetForEffort(m, e)),
    [512, 1024, 2048, 4096, 8192],
    "a doubling ladder from ctx/32 up to the ctx/2 ceiling",
  );
});

test("no effort level may exceed the enforced ceiling", () => {
  for (const context of [4096, 8192, 16384, 32768, 131072]) {
    const m = { capabilities: ["thinking"], context } as never;
    const { max } = reasoningRange(m);
    for (const e of ["low", "medium", "high", "xhigh", "max"] as const) {
      assert.ok(
        budgetForEffort(m, e) <= max,
        `${e} at context ${context} exceeded the ${max} ceiling`,
      );
    }
  }
});

test("effort is ignored for a model with no thinking mode", () => {
  const m = { capabilities: ["tools"], context: 16384 } as never;
  for (const e of ["low", "high", "max"] as const) {
    assert.equal(budgetForEffort(m, e), 0, e);
  }
});

test("effort is read from output_config, and anything unrecognised is ignored", () => {
  // Tolerant inbound: Claude Code adds fields to output_config across releases, and a
  // level we do not know about must not throw or be guessed at.
  assert.equal(readEffort({ output_config: { effort: "xhigh" } }), "xhigh");
  assert.equal(readEffort({ output_config: { effort: "ludicrous" } }), null);
  assert.equal(readEffort({ output_config: {} }), null);
  assert.equal(readEffort({}), null);
  assert.equal(readEffort({ output_config: null }), null);
  assert.equal(readEffort({ output_config: "high" }), null);
});

test("an explicit catalog budget beats the derived one", async () => {
  const reg = await Registry.load(
    writeRegistry(VALID.replace("capabilities: [tools]", "capabilities: [tools, thinking]\n    reasoning_budget: 777")),
    HOST,
  );
  assert.equal(reg.get("local-claude-test")!.reasoningBudget, 777);
});
