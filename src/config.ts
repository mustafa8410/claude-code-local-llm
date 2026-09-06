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
  /**
   * Require a valid client credential. Off by default: the gateway is meant to be
   * reached over loopback, where a token excludes nobody. Implied by GATEWAY_API_KEY.
   */
  requireAuth: boolean;
  /**
   * The secret clients must present. Auth is a comparison against this or it is
   * nothing - a presence-only check accepts any non-empty string, which is exactly
   * what an attacker sends.
   */
  gatewayApiKey: string | null;
  /**
   * Override the detected RAM budget, in GB. Detection is least reliable exactly
   * where it matters: WSL2 hands its VM a share of host RAM that neither
   * `os.totalmem()` nor the cgroup limit describes.
   */
  memoryBudgetGb: number | null;
  /**
   * Start anyway when no GPU is detected. Off by default: a 9B model on CPU answers at
   * roughly 2 tok/s, which reads as a broken gateway rather than a slow one, and the
   * overwhelmingly likely cause is a missing `--gpus all` rather than a deliberate
   * choice. Refusing loudly at startup points at that; serving slowly hides it.
   */
  allowCpu: boolean;
  /**
   * Default thinking budget for models the catalog does not pin. `-1` unrestricted,
   * `0` off, `N` a token budget. Per-model `reasoning_budget` still wins.
   */
  reasoningBudget: number | null;
  /**
   * Let Claude Code's `output_config.effort` pick the thinking budget from this model's
   * allowed range.
   *
   * On by default, which is only defensible because the ladder is anchored: Claude Code
   * sends `high` when the user has set no preference, and `high` maps to the budget the
   * model already had. Measured over a twelve-request session with the dial untouched -
   * zero budget changes, one backend spawn. Someone who never turns the dial pays
   * nothing; the feature costs a reload only when they deliberately change it, and the
   * change then takes effect on the very next request.
   */
  effortFollowsClient: boolean;
  /**
   * How many consecutive requests must carry a level before it is acted on.
   *
   * DEFAULT 1: the user's chosen level takes effect on the very next request.
   *
   * This was 3, to starve an alternating client of the chance to force a respawn - a
   * soak phase once produced 36 effort changes and 35 reloads. But the delay bought
   * nothing in the case that actually matters. Someone who exports
   * CLAUDE_CODE_EFFORT_LEVEL before launching sends the SAME level on every request, so
   * a streak of 3 does not prevent a reload, it only postpones it to the third request -
   * identical reload count, two requests served at a budget the user did not ask for.
   * It pays off only against alternation, and the alternation was never traced to effort
   * handling at all; a rerun with identical settings did not reproduce it.
   *
   * So the default stops charging every user for an unconfirmed diagnosis. Raise it if
   * an alternating client ever shows up for real.
   */
  effortStreak: number;
  /**
   * Which model each `/model` tier selects, overriding the automatic pick.
   *
   * Claude Code's picker has exactly three rows - Opus, Sonnet, Haiku - and they are
   * these three variables. That is a property of Claude Code, NOT a limit on the
   * catalog: any number of models can be served, and anything outside the three is
   * still reachable by naming it in ANTHROPIC_MODEL. These only decide which three get
   * a one-keystroke shortcut.
   *
   * Unset, the gateway picks by size from the models that fit this host: largest to
   * Opus, smallest to Haiku, middle to Sonnet.
   */
  tierOpus: string | null;
  tierSonnet: string | null;
  tierHaiku: string | null;
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

function envFloat(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
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

  const gatewayApiKey = process.env.GATEWAY_API_KEY?.trim() || null;
  const requireAuthFlag = envBool("REQUIRE_AUTH", false);
  // Refuse the combination that looks secure and is not. REQUIRE_AUTH on its own used
  // to accept any non-empty token, so the setting a user reached for when exposing the
  // port past localhost bought them nothing at all.
  if (requireAuthFlag && gatewayApiKey === null) {
    throw new Error(
      "REQUIRE_AUTH=1 needs GATEWAY_API_KEY set to the secret clients must send. " +
        "Without something to compare against, any non-empty token is accepted.",
    );
  }

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
    // Setting a key is itself a statement of intent, so it enables enforcement.
    requireAuth: requireAuthFlag || gatewayApiKey !== null,
    gatewayApiKey,
    memoryBudgetGb: envFloat("MEMORY_BUDGET_GB", null),
    allowCpu: envBool("ALLOW_CPU", false),
    reasoningBudget:
      process.env.REASONING_BUDGET === undefined || process.env.REASONING_BUDGET === ""
        ? null
        : envInt("REASONING_BUDGET", 0),
    effortFollowsClient: envBool("EFFORT_FOLLOWS_CLIENT", true),
    effortStreak: Math.max(1, envInt("EFFORT_STREAK", 1)),
    tierOpus: process.env.TIER_OPUS?.trim() || null,
    tierSonnet: process.env.TIER_SONNET?.trim() || null,
    tierHaiku: process.env.TIER_HAIKU?.trim() || null,
    toolProfile: process.env.TOOL_PROFILE ?? null,
    captureDir: process.env.CAPTURE_DIR ?? null,
    logLevel: envEnum("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };
}
