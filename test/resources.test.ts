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

const Q8 = ["-ngl", "999", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"];

test("the context window changes the estimate, because the KV cache is real", () => {
  // The old estimate was `size_gb * 1.15` and could not see `context` at all, so
  // quadrupling the window moved it by exactly nothing. Measured on an 8 GB card, the
  // 9B went 5778 MiB at 16K to 6834 MiB at 64K - over a gigabyte the estimate missed.
  //
  // Probed with a host sized between the two: if context were ignored, both would land
  // on the same side of it.
  const between = { vramTotalMb: 6600, vramFreeMb: 6600, ramTotalMb: 0, ramFreeMb: 0 };
  assert.equal(
    checkFit(5.56, "vram", between, { contextTokens: 16384, args: Q8 }).fits, true,
    "16K fits under 6600 MiB",
  );
  assert.equal(
    checkFit(5.56, "vram", between, { contextTokens: 65536, args: Q8 }).fits, false,
    "64K does not - and the old flat estimate could not tell these apart",
  );

  // On the real 8 GB card both are genuinely fine; 64K measured 6834 MiB.
  assert.equal(checkFit(5.56, "vram", GPU, { contextTokens: 16384, args: Q8 }).fits, true);
  assert.equal(checkFit(5.56, "vram", GPU, { contextTokens: 65536, args: Q8 }).fits, true);
});

test("an unquantised KV cache is charged at twice the rate", () => {
  // The catalog passes q8_0; an entry a user adds may not, and f16 is about double.
  // Charging the cheap rate for the expensive cache is the direction that OOMs.
  const quantised = checkFit(5.56, "vram", GPU, { contextTokens: 65536, args: Q8 });
  const f16 = checkFit(5.56, "vram", GPU, { contextTokens: 65536, args: ["-ngl", "999"] });
  assert.equal(quantised.fits, true);
  assert.equal(f16.fits, false, "f16 KV at 64K does not fit beside a 5.56 GB model");
});

test("a vision model is charged for its projector", () => {
  // size_gb describes the weights only. The 9B's mmproj is an 879 MiB file that cost
  // 1130 MiB resident, and counting it as zero is what let a 6908 MiB configuration
  // pass a 6547 MiB estimate.
  const withVision = checkFit(5.56, "vram", GPU, {
    contextTokens: 65536, args: Q8, capabilities: ["tools", "vision"],
  });
  const without = checkFit(5.56, "vram", GPU, {
    contextTokens: 65536, args: Q8, capabilities: ["tools"],
  });
  assert.equal(without.fits, true);
  assert.equal(withVision.fits, false, "vision + 64K is over 8 GB; it must not pass");
});

test("the estimate never under-counts a real measurement", () => {
  // Each of these was measured with nvidia-smi on an RTX 3070 Ti Laptop, idle GPU at
  // 0 MiB so the figure is all model. The estimate must be >= actual in every case:
  // over-estimating refuses a config that might have squeezed in, under-estimating
  // invites an OOM kill with nothing in the logs explaining it.
  //
  // The old `size_gb * 1.15` failed exactly this bound - it put the 9B with vision at
  // 6547 MiB when the truth was 6908.
  const measured: Array<[string, number, number, string[], number]> = [
    ["4B 16K", 2.71, 16384, [], 3406],
    ["4B 64K", 2.71, 65536, [], 4462],
    ["9B 16K", 5.56, 16384, [], 5778],
    ["9B 32K", 5.56, 32768, [], 6156],
    ["9B 64K", 5.56, 65536, [], 6834],
    ["9B 16K +vision", 5.56, 16384, ["vision"], 6908],
  ];

  // A host large enough that nothing is refused, so every case reports its estimate.
  const huge = { vramTotalMb: 9_999_999, vramFreeMb: 9_999_999, ramTotalMb: 1, ramFreeMb: 1 };

  for (const [name, sizeGb, ctx, caps, actualMb] of measured) {
    const fit = checkFit(sizeGb, "vram", huge, {
      contextTokens: ctx, args: Q8, capabilities: caps,
    });
    assert.equal(fit.fits, true, `${name} should fit a huge host`);
    // The note only quotes a figure when it does NOT fit, so re-ask against a host
    // sized exactly at the measurement: if the estimate were below actual, this would
    // report "fits" and prove the estimate too optimistic.
    const tight = { vramTotalMb: actualMb, vramFreeMb: actualMb, ramTotalMb: 0, ramFreeMb: 0 };
    const atActual = checkFit(sizeGb, "vram", tight, {
      contextTokens: ctx, args: Q8, capabilities: caps,
    });
    assert.equal(
      atActual.fits, false,
      `${name}: estimate must exceed the measured ${actualMb} MiB, not undercut it`,
    );
  }
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
