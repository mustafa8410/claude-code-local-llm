/**
 * Runtime-added models.
 *
 * The image ships a catalog chosen for one 8 GB laptop, which is no basis for deciding
 * what anyone else may run. These cover the rules a user-supplied entry has to clear -
 * deliberately the same ones the baked catalog clears, because the id constraints in
 * particular fail silently at runtime rather than erroring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.ts";
import {
  loadCustomModels, saveCustomModels, customModelsPath, verifyHuggingFaceRepo,
} from "../src/custom-models.ts";
import type { Config } from "../src/config.ts";
import type { HostResources, ModelEntry } from "../src/types.ts";

const HOST: HostResources = {
  vramTotalMb: 8191, vramFreeMb: 7113, ramTotalMb: 15629, ramFreeMb: 5000,
};

const CATALOG = `
models:
  - id: local-claude-baked
    hf: org/repo:Q4_K_M
    size_gb: 1
    context: 16384
    capabilities: [tools]
    tier: vram
    default: true
`;

async function registry(): Promise<Registry> {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-"));
  const file = path.join(dir, "models.yaml");
  writeFileSync(file, CATALOG, "utf8");
  return Registry.load(file, HOST);
}

function cfg(cacheDir: string): Config {
  return {
    port: 8787, host: "127.0.0.1", backendPort: 8080, serverBin: "llama-server",
    registryPath: "config/models.yaml", modelCacheDir: cacheDir,
    idleTtlSeconds: 900, keepaliveMs: 10_000, streamWatchdogMs: 300_000,
    backgroundStrategy: "reuse-primary", backendApiKey: "k",
    requireAuth: false, gatewayApiKey: null, memoryBudgetGb: null, allowCpu: false,
    reasoningBudget: null, effortFollowsClient: true, effortStreak: 3,
    tierOpus: null, tierSonnet: null, tierHaiku: null,
    toolProfile: null, captureDir: null, logLevel: "error",
  };
}

const good = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: "local-claude-mine", hf: "someone/their-model:Q4_K_M",
  size_gb: 2, context: 8192, capabilities: ["tools"], tier: "vram",
  ...over,
}) as ModelEntry;

test("a user can add a model the image never shipped", async () => {
  const reg = await registry();
  const added = reg.add(good(), HOST);
  assert.equal(added.id, "local-claude-mine");
  assert.equal(added.available, true);
  assert.equal(added.custom, true, "must be distinguishable from a catalog entry");
  assert.ok(reg.get("local-claude-mine"), "and immediately resolvable, without a restart");
});

test("a runtime model is held to the same silent-failure id rules", async () => {
  const reg = await registry();
  // Neither of these errors at runtime - one vanishes from the picker, the other makes
  // Claude Code assume a 200K window. Both must be refused here instead.
  assert.throws(() => reg.add(good({ id: "my-model" }), HOST), /must contain "claude"/);
  assert.throws(() => reg.add(good({ id: "claude-mine" }), HOST), /must not START/);
  assert.throws(() => reg.add(good({ id: "local-claude-x[1m]" }), HOST), /\[1m\]/);
});

test("an incomplete entry is rejected with every problem at once", async () => {
  const reg = await registry();
  assert.throws(
    () => reg.add({ id: "local-claude-bad" } as ModelEntry, HOST),
    (err: Error) => {
      assert.match(err.message, /needs either `hf` or `path`/);
      assert.match(err.message, /size_gb/);
      assert.match(err.message, /context/);
      return true;
    },
  );
});

test("a model too large for the host is added but marked unavailable", async () => {
  // Refusing outright would be wrong: the user may be about to raise the memory budget,
  // and /admin/models should be able to explain the shortfall rather than forget it.
  const reg = await registry();
  const added = reg.add(good({ id: "local-claude-huge", size_gb: 400 }), HOST);
  assert.equal(added.available, false);
  assert.match(added.unavailableReason ?? "", /GB/);
});

test("a duplicate id cannot shadow a catalog model", async () => {
  const reg = await registry();
  assert.throws(() => reg.add(good({ id: "local-claude-baked" }), HOST), /duplicate/);
});

test("a runtime model cannot seize `default` from the catalog", async () => {
  const reg = await registry();
  assert.throws(() => reg.add(good({ default: true }), HOST), /cannot claim `default`/);
});

test("only runtime models can be removed", async () => {
  const reg = await registry();
  reg.add(good(), HOST);
  reg.remove("local-claude-mine");
  assert.equal(reg.get("local-claude-mine"), undefined);

  assert.throws(
    () => reg.remove("local-claude-baked"),
    /comes from the catalog file/,
    "deleting a catalog entry through the API would diverge the gateway from its config",
  );
});

test("added models survive a restart", async () => {
  const cache = mkdtempSync(path.join(tmpdir(), "cache-"));
  const c = cfg(cache);

  const first = await registry();
  first.add(good(), HOST);
  await saveCustomModels(first, c);
  assert.ok(existsSync(customModelsPath(c)));

  const second = await registry();
  assert.equal(second.get("local-claude-mine"), undefined, "not in the baked catalog");
  await loadCustomModels(second, c, HOST);
  assert.ok(second.get("local-claude-mine"), "restored from the volume");
});

test("the persisted file holds catalog fields, not resolved runtime state", async () => {
  const cache = mkdtempSync(path.join(tmpdir(), "cache-"));
  const c = cfg(cache);
  const reg = await registry();
  reg.add(good(), HOST);
  await saveCustomModels(reg, c);

  const text = await readFile(customModelsPath(c), "utf8");
  assert.match(text, /local-claude-mine/);
  assert.ok(!text.includes("available:"), "availability is a property of THIS host");
  assert.ok(!text.includes("unavailableReason"), "and so is the shortfall");
});

test("a stale stored model is skipped, not fatal at startup", async () => {
  // This file is written by a past version of the API and can go stale in ways the
  // baked catalog cannot. One bad entry must not stop the gateway serving the rest.
  const cache = mkdtempSync(path.join(tmpdir(), "cache-"));
  const c = cfg(cache);
  writeFileSync(
    customModelsPath(c),
    "models:\n  - id: totally-invalid-id\n    hf: o/r:Q4\n    size_gb: 1\n" +
      "    context: 8192\n    capabilities: [tools]\n    tier: vram\n" +
      "  - id: local-claude-fine\n    hf: o/r:Q4\n    size_gb: 1\n" +
      "    context: 8192\n    capabilities: [tools]\n    tier: vram\n",
    "utf8",
  );

  const reg = await registry();
  await loadCustomModels(reg, c, HOST); // must not throw
  assert.equal(reg.get("totally-invalid-id"), undefined, "the bad one is dropped");
  assert.ok(reg.get("local-claude-fine"), "the good one still loads");
});

test("unparseable YAML does not stop the gateway starting", async () => {
  const cache = mkdtempSync(path.join(tmpdir(), "cache-"));
  const c = cfg(cache);
  writeFileSync(customModelsPath(c), "models: [ this is not: valid: yaml", "utf8");
  const reg = await registry();
  await loadCustomModels(reg, c, HOST);
  assert.ok(reg.get("local-claude-baked"), "the catalog is still served");
});

test("a missing file is the normal case, not an error", async () => {
  const cache = mkdtempSync(path.join(tmpdir(), "cache-"));
  const reg = await registry();
  await loadCustomModels(reg, cfg(cache), HOST);
  assert.equal(reg.list().length, 1);
});

/**
 * Repo verification at add time.
 *
 * The failure this prevents is genuinely awful, and it happened during container testing:
 * a repo that does not exist is accepted with a 201, then surfaces minutes later at pull
 * time as llama-server's `exactly one out metadata, path_model, and file must be defined`
 * followed by `failed to load model ''` - neither of which mentions the repo name. The
 * network is stubbed here; what is under test is the decision, not Hugging Face's uptime.
 */
type Fetch = typeof globalThis.fetch;

async function withFetch<T>(stub: Fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const responds = (status: number): Fetch =>
  (async () => new Response(null, { status })) as Fetch;

test("a malformed hf spec is rejected without asking the network", async () => {
  const asked = { yes: false };
  await withFetch(
    (() => {
      asked.yes = true;
      throw new Error("must not be called");
    }) as Fetch,
    async () => {
      for (const bad of ["justamodel", "", ":Q4_K_M"]) {
        const r = await verifyHuggingFaceRepo(bad);
        assert.equal(r.ok, false, `"${bad}" should not be accepted`);
        assert.match(r.reason ?? "", /org\/repo/);
      }
    },
  );
  assert.equal(asked.yes, false, "a shape error needs no round trip");
});

test("a repo Hugging Face does not serve is refused, naming both causes", async () => {
  // 401 is what HF answers for BOTH a nonexistent repo and a gated one, so the message
  // must not claim it is a typo.
  const r = await withFetch(responds(401), () =>
    verifyHuggingFaceRepo("unsloth/Qwen3.5-1B-GGUF:UD-Q4_K_XL"));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /unsloth\/Qwen3\.5-1B-GGUF/);
  assert.match(r.reason ?? "", /gated or private/);
  assert.ok(!(r.reason ?? "").includes("UD-Q4_K_XL"), "the quant is not part of the repo id");
});

test("a real repo passes with nothing to report", async () => {
  const r = await withFetch(responds(200), () =>
    verifyHuggingFaceRepo("unsloth/Qwen3.5-2B-GGUF:UD-Q4_K_XL"));
  assert.deepEqual(r, { ok: true });
});

test("an unreachable Hugging Face accepts the model rather than blocking setup", async () => {
  // Someone setting up offline must still be able to add a model whose weights are
  // already in the volume. This check is advisory, not a gate.
  const r = await withFetch((() => Promise.reject(new Error("ENOTFOUND"))) as Fetch, () =>
    verifyHuggingFaceRepo("someone/their-model:Q4_K_M"));
  assert.equal(r.ok, true);
  assert.match(r.reason ?? "", /could not reach/);
});
