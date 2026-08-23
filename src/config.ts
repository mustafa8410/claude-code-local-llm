/** Gateway configuration, resolved from environment with documented defaults. */

import { randomBytes } from "node:crypto";
import path from "node:path";

export type BackgroundStrategy = "reuse-primary" | "swap" | "reject";

export interface Config {
  port: number;
  host: string;
  /** Port llama-server is spawned on. Bound to loopback inside the container. */
  backendPort: number;
  serverBin: string;
  registryPath: string;
  modelCacheDir: string;
  /** Unload the backend after this many seconds with no requests. 0 disables. */
  idleTtlSeconds: number;
  /** Interval between SSE keepalive comment lines while a swap is in flight. */
  keepaliveMs: number;
  /**
   * Claude Code aborts a stream that relays no bytes for 300s. Everything the
   * gateway does during a gap must stay comfortably inside that budget.
   */
  streamWatchdogMs: number;
  /** How a request for a non-primary model is handled. See BackgroundStrategy. */
  backgroundStrategy: BackgroundStrategy;
  /** Shared secret llama-server requires; generated per-process, never leaves it. */
  backendApiKey: string;
  /** Require a non-empty client credential. Off by default for localhost use. */
  requireAuth: boolean;
  toolProfile: string | null;
  captureDir: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join("|")}, got ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

export function loadConfig(): Config {
  const root = process.env.GATEWAY_ROOT ?? process.cwd();
  return {
    port: envInt("PORT", 8787),
    host: process.env.HOST ?? "0.0.0.0",
    backendPort: envInt("BACKEND_PORT", 8080),
    serverBin: process.env.LLAMA_SERVER_BIN ?? "llama-server",
    registryPath: process.env.MODELS_CONFIG ?? path.join(root, "config", "models.yaml"),
    modelCacheDir: process.env.LLAMA_CACHE ?? path.join(root, "models"),
    idleTtlSeconds: envInt("IDLE_TTL_SECONDS", 900),
    keepaliveMs: envInt("KEEPALIVE_MS", 10_000),
    streamWatchdogMs: envInt("STREAM_WATCHDOG_MS", 300_000),
    backgroundStrategy: envEnum(
      "BACKGROUND_STRATEGY",
      ["reuse-primary", "swap", "reject"] as const,
      "reuse-primary",
    ),
    backendApiKey: randomBytes(24).toString("hex"),
    requireAuth: envBool("REQUIRE_AUTH", false),
    toolProfile: process.env.TOOL_PROFILE ?? null,
    captureDir: process.env.CAPTURE_DIR ?? null,
    logLevel: envEnum("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };
}
