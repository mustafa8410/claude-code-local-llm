/**
 * Host-resource tests.
 *
 * These cover the fit arithmetic that decides whether a model is offered at all. Every
 * case here is a regression: getting any of them wrong does not throw, it just makes
 * the gateway quietly refuse to serve, which is the hardest kind of failure to debug
 * from the outside.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFit, probeResources } from "../src/resources.ts";
import type { HostResources } from "../src/types.ts";

const GPU: HostResources = {
  vramTotalMb: 8191,
  vramFreeMb: 7113,
  ramTotalMb: 15629,
  ramFreeMb: 5000,
};

const NO_GPU: HostResources = {
  vramTotalMb: null,
  vramFreeMb: null,
  ramTotalMb: 15629,
  ramFreeMb: 5000,
};

test("a vram-tier model on a GPU-less host is judged against RAM, not against zero", () => {
  // Regression: `res.vramTotalMb ?? 0` held vram-tier models to a zero-byte budget
  // whenever VRAM detection failed, so EVERY model in the catalog was marked
  // unavailable. That is not an exotic case - it is a missing --gpus all, an absent
  // NVIDIA Container Toolkit, a CUDA image mismatched to the host driver, a laptop
  // dGPU switched off for power, or any macOS host pulling the published image. The
  // gateway would start, answer /health, list every model, and 400 every request.
  const fit = checkFit(5.56, "vram", NO_GPU);
  assert.equal(fit.fits, true, fit.note);
  assert.match(fit.note, /no GPU/i, "the note must say why RAM is the budget");
});

test("a GPU-less host still rejects a model larger than its RAM, naming the shortfall", () => {
  const fit = checkFit(400, "vram", NO_GPU);
  assert.equal(fit.fits, false);
  assert.ok(fit.shortfallGb > 0, "the shortfall must be quantified, not just flagged");
  assert.match(fit.note, /GB/);
});

test("a real GPU still holds vram-tier models to the VRAM budget", () => {
  // The fallback must not weaken the check where a GPU does exist: 16.41 GB does not
  // belong in 8 GB of VRAM merely because the host also has system RAM.
  assert.equal(checkFit(16.41, "vram", GPU).fits, false, "must not spill silently");
  assert.equal(checkFit(5.56, "vram", GPU).fits, true);
});

test("offload and stretch tiers may spill into system RAM", () => {
  assert.equal(checkFit(15.69, "stretch", GPU).fits, true);
  assert.equal(checkFit(400, "stretch", GPU).fits, false);
});

test("MEMORY_BUDGET_GB overrides whatever the host claims", async () => {
  // os.totalmem() reports the host - or the WSL2 VM - and ignores cgroup limits, so a
  // container run with --memory needs a way to be told its real budget. Without it a
  // 64 GB host would load a model an 8 GB container cannot hold and be OOM-killed
  // with exit 137 and no log line of ours to explain it.
  const res = await probeResources("definitely-not-a-real-binary", 4);
  assert.equal(res.ramTotalMb, 4096);
  assert.equal(res.vramTotalMb, null, "a missing binary must probe as no GPU, not throw");
});
