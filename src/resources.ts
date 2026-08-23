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

export async function probeResources(serverBin: string): Promise<HostResources> {
  const devices = await listGpuDevices(serverBin);
  const primary = devices[0];
  return {
    vramTotalMb: primary ? primary.totalMb : null,
    vramFreeMb: primary ? primary.freeMb : null,
    ramTotalMb: Math.round(os.totalmem() / (1024 * 1024)),
    ramFreeMb: Math.round(os.freemem() / (1024 * 1024)),
  };
}

/**
 * Whether a model of `sizeGb` can plausibly be served, and if not, by how much it
 * misses. The shortfall is reported in GB so the error message can name a number
 * instead of saying "not enough memory".
 */
export function checkFit(
  sizeGb: number,
  tier: "vram" | "offload" | "stretch",
  res: HostResources,
): { fits: boolean; shortfallGb: number; note: string } {
  const sizeMb = sizeGb * 1024;
  // Weights plus KV cache plus CUDA compute buffers. The headroom factor is
  // deliberately conservative; a model that "just fits" thrashes.
  const needMb = sizeMb * 1.15;

  if (tier === "vram") {
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

  // offload and stretch may spill into system RAM.
  const haveMb = (res.vramTotalMb ?? 0) + res.ramTotalMb;
  const shortMb = needMb - haveMb;
  return shortMb <= 0
    ? { fits: true, shortfallGb: 0, note: "fits across VRAM + RAM" }
    : {
        fits: false,
        shortfallGb: round1(shortMb / 1024),
        note: `needs ~${round1(needMb / 1024)} GB across VRAM+RAM, host has ${round1(haveMb / 1024)} GB`,
      };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
