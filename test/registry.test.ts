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
import { Registry } from "../src/registry.ts";
import { pruneTools } from "../src/tools/prune.ts";
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
