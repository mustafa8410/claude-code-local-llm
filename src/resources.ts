/**
 * Host resource probing.
 *
 * VRAM comes from `llama-server --list-devices` rather than NVML bindings: the
 * binary we already ship reports both total and free VRAM, so there is no native
 * addon to build, nothing extra to install in the container, and no chance of the
 * probe disagreeing with the process that actually allocates the memory.
 *
 * Sample output parsed here:
 *   CUDA0: NVIDIA GeForce RTX 3070 Ti Laptop GPU (8191 MiB, 7113 MiB free)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { HostResources } from "./types.ts";

const execFileAsync = promisify(execFile);

const DEVICE_RE = /^\s*(\w+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/;

export interface GpuDevice {
  handle: string;
  name: string;
  totalMb: number;
  freeMb: number;
}

export async function listGpuDevices(serverBin: string): Promise<GpuDevice[]> {
  try {
    const { stdout } = await execFileAsync(serverBin, ["--list-devices"], {
      timeout: 15_000,
      windowsHide: true,
    });
    const devices: GpuDevice[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = DEVICE_RE.exec(line);
      if (!m) continue;
      devices.push({
        handle: m[1]!,
        name: m[2]!,
        totalMb: Number(m[3]),
        freeMb: Number(m[4]),
      });
    }
    return devices;
  } catch {
    // No GPU, or the binary is missing. CPU-only is a valid configuration.
    return [];
  }
}

const MB = 1024 * 1024;

/**
 * Total RAM this process may actually use, in MB.
 *
 * `os.totalmem()` reports the host - or, under Docker Desktop, the WSL2 VM - and
 * ignores cgroup limits entirely. A container started with `--memory=8g` on a 64 GB
 * host would therefore believe it has 64 GB, mark a model that cannot possibly fit as
 * available, load it, and be OOM-killed by the kernel: exit code 137, no log line, no
 * explanation anywhere in our output.
 *
 * `process.constrainedMemory()` returns the cgroup limit under both v1 and v2, or 0
 * when the process is unconstrained, so the smaller of the two is the honest figure.
 * An explicit MEMORY_BUDGET_GB wins over both, because detection is unreliable exactly
 * where it matters most - WSL2 hands the VM a share of host RAM that neither number
 * describes.
 */
function totalRamMb(overrideGb: number | null): number {
  if (overrideGb !== null && overrideGb > 0) return Math.round(overrideGb * 1024);

  const hostMb = Math.round(os.totalmem() / MB);
  const constrained = process.constrainedMemory();
  if (typeof constrained === "number" && constrained > 0) {
    return Math.min(hostMb, Math.round(constrained / MB));
  }
  return hostMb;
}

export async function probeResources(
  serverBin: string,
  memoryBudgetGb: number | null = null,
): Promise<HostResources> {
  const devices = await listGpuDevices(serverBin);
  const primary = devices[0];
  return {
    vramTotalMb: primary ? primary.totalMb : null,
    vramFreeMb: primary ? primary.freeMb : null,
    ramTotalMb: totalRamMb(memoryBudgetGb),
    ramFreeMb: Math.round(os.freemem() / MB),
  };
}

/**
 * Whether a model of `sizeGb` can plausibly be served, and if not, by how much it
 * misses. The shortfall is reported in GB so the error message can name a number
 * instead of saying "not enough memory".
 */
/**
 * How much VRAM a KV cache costs, per 1024 tokens of context.
 *
 * Measured on an RTX 3070 Ti Laptop, Qwen3.5 at `--cache-type-k/v q8_0`. Two models
 * agreed to the megabyte, because the 4B and the 9B share KV geometry:
 *
 *   4B   16K 3406 MiB -> 64K 4462 MiB   = 1056 MiB for 49,152 tokens
 *   9B   16K 5778 MiB -> 64K 6834 MiB   = 1056 MiB for 49,152 tokens
 *
 * That is 22 MiB per 1K tokens. It is a property of the attention shape, not of the
 * parameter count, so it does NOT scale with size_gb - which is exactly why the old
 * flat `size * 1.15` could not see a context change at all.
 */
const KV_MB_PER_1K_Q8 = 22;

/**
 * An unquantised KV cache is roughly twice the size. Rather than guess, look at what
 * the model's own spawn args ask for: the shipped catalog passes q8_0, but a
 * user-added entry that omits it gets f16 and a cache twice as large.
 */
function kvMbFor(contextTokens: number, args: readonly string[] | undefined): number {
  const quantised = (args ?? []).some((a) => /^q\d/.test(a));
  const rate = quantised ? KV_MB_PER_1K_Q8 : KV_MB_PER_1K_Q8 * 2;
  return (contextTokens / 1024) * rate;
}

/**
 * A vision model loads a multimodal projector beside the weights, and `size_gb`
 * describes only the weights. Measured on the Qwen3.5 9B: an 879 MiB mmproj file cost
 * 1130 MiB resident. Projector sizes vary by model, so this is a floor rather than a
 * precise figure - but counting zero, as this used to, is the one certainly wrong
 * answer, and it is wrong in the direction that OOMs.
 */
const VISION_MB = 1130;

/** CUDA context and compute buffers. Empirically ~280 MiB; rounded up. */
const OVERHEAD_MB = 400;

export function checkFit(
  sizeGb: number,
  tier: "vram" | "offload" | "stretch",
  res: HostResources,
  opts: {
    contextTokens?: number | undefined;
    capabilities?: readonly string[] | undefined;
    args?: readonly string[] | undefined;
  } = {},
): { fits: boolean; shortfallGb: number; note: string } {
  const sizeMb = sizeGb * 1024;

  // Weights + KV cache + projector + compute buffers, each counted separately.
  //
  // This replaces a flat `sizeMb * 1.15`, which was blind to the two things that
  // actually move: the context window and the vision projector. That mattered - the
  // 9B with vision at 16K really used 6908 MiB against an estimate of 6547, so the
  // estimate said "fits" while under-counting by 361 MiB. Verified against six
  // measurements, this over-estimates by 120-660 MiB, which is the safe direction:
  // it may refuse a config that would have squeezed in, but it does not invite an OOM.
  const kvMb = opts.contextTokens ? kvMbFor(opts.contextTokens, opts.args) : 0;
  const visionMb = (opts.capabilities ?? []).includes("vision") ? VISION_MB : 0;
  const needMb = sizeMb + kvMb + visionMb + OVERHEAD_MB;
  const hasGpu = res.vramTotalMb !== null;

  // A vram-tier model is held to the VRAM budget only when there IS a GPU.
  //
  // Judging it against zero on a GPU-less host marks the ENTIRE catalog unavailable,
  // so the gateway starts, answers /health, lists every model, and then 400s every
  // single request. That is not a rare configuration: it is what happens when
  // --gpus all is omitted, when the NVIDIA Container Toolkit is missing, when the
  // CUDA base image does not match the host driver, when the discrete GPU is switched
  // off to save power, and on every macOS host that pulls the published image.
  //
  // So fall through to the RAM budget instead, which keeps the host serviceable and
  // makes the shortfall message honest. Whether the gateway is ALLOWED to run this way
  // is a separate question, decided once at startup rather than per model - see the
  // ALLOW_CPU gate in server.ts.
  if (tier === "vram" && hasGpu) {
    const haveMb = res.vramTotalMb ?? 0;
    const shortMb = needMb - haveMb;
    return shortMb <= 0
      ? { fits: true, shortfallGb: 0, note: "fits in VRAM" }
      : {
          fits: false,
          shortfallGb: round1(shortMb / 1024),
          note: `needs ~${round1(needMb / 1024)} GB VRAM, host has ${round1(haveMb / 1024)} GB`,
        };
  }

  // offload and stretch may spill into system RAM - and so may a vram-tier model on a
  // host with no GPU at all, where every layer runs on the CPU regardless of tier.
  const haveMb = (res.vramTotalMb ?? 0) + res.ramTotalMb;
  const shortMb = needMb - haveMb;
  if (shortMb > 0) {
    return {
      fits: false,
      shortfallGb: round1(shortMb / 1024),
      note: hasGpu
        ? `needs ~${round1(needMb / 1024)} GB across VRAM+RAM, host has ${round1(haveMb / 1024)} GB`
        : `needs ~${round1(needMb / 1024)} GB RAM, host has ${round1(haveMb / 1024)} GB and no GPU`,
    };
  }
  return {
    fits: true,
    shortfallGb: 0,
    note: hasGpu ? "fits across VRAM + RAM" : "fits in RAM (no GPU - CPU inference, slow)",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
