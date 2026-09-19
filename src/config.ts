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
   * Unset, each follows the primary model - see tierMode for why that is the default.
   * Under TIER_MODE=distinct they instead take the largest, middle and smallest model
   * that fits this host.
   */
  tierOpus: string | null;
  tierSonnet: string | null;
  tierHaiku: string | null;
  /**
   * `follow` (default) points every tier at the primary model. `distinct` gives each
   * tier its own model, picked by size.
   *
   * `distinct` reads better in the picker and is a trap on one GPU: Claude Code runs
   * side tasks - titling, and compaction's summarising step - on the small tier by
   * design, so an interactive session alternates between two models and spends itself
   * loading them. Observed directly: a backend reaching ready and being torn down 17 ms
   * later, over and over, with `backend unreachable` between. The picker gets its real
   * choices from gateway model discovery instead, which offers the whole catalog.
   */
  tierMode: "follow" | "distinct";
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

/**
 * Where the full documentation lives.
 *
 * Anything the container prints or serves that points at "the README" has to carry this,
 * because a person who ran `docker pull` has no repository to look in and no reason to
 * know the project is on GitHub at all. Kept in one place so the banner, /admin/config
 * and the image's own OCI label cannot drift apart - test/config.test.ts checks the
 * Dockerfile agrees with it.
 */
export const REPO = "https://github.com/mustafa8410/claude-code-local-llm";

/**
 * Every environment variable this gateway reads, for `GET /admin/config`.
 *
 * The container is the only documentation somebody who pulled the image actually has.
 * Before this existed the options lived solely in a README on GitHub, which a
 * `docker run` never shows you, and /admin/metrics published four of the twenty-four.
 *
 * `test/config.test.ts` reads THIS FILE and fails if any env var the code consults is
 * missing here, so the list cannot quietly fall behind the parsing below it.
 */
export const OPTIONS: ReadonlyArray<{
  name: string;
  def: string;
  doc: string;
}> = [
  { name: "PORT", def: "8787", doc: "port the gateway listens on" },
  { name: "HOST", def: "0.0.0.0", doc: "interface to bind" },
  { name: "TOOL_PROFILE", def: "unset",
    doc: "coding | analysis | any tool list. UNSET MEANS NO PRUNING, which leaves a " +
      "local model little room - see the startup warning" },
  { name: "ALLOW_CPU", def: "0",
    doc: "start without a GPU. Prefill is ~18 tok/s; Claude Code is unlikely to be usable" },
  { name: "MEMORY_BUDGET_GB", def: "detected",
    doc: "override the detected RAM budget, for when WSL2 detection is wrong" },
  { name: "GATEWAY_API_KEY", def: "unset",
    doc: "secret clients must send. Setting it turns authentication on" },
  { name: "REQUIRE_AUTH", def: "0",
    doc: "require a credential; refuses to start without GATEWAY_API_KEY" },
  { name: "BACKGROUND_STRATEGY", def: "reuse-primary",
    doc: "reuse-primary | swap | reject - what to do with an unrecognised model id" },
  { name: "IDLE_TTL_SECONDS", def: "900", doc: "unload the backend after this idle time; 0 disables" },
  { name: "REASONING_BUDGET", def: "per-model",
    doc: "default thinking budget. -1 unrestricted, 0 off, N tokens" },
  { name: "EFFORT_FOLLOWS_CLIENT", def: "1",
    doc: "let CLAUDE_CODE_EFFORT_LEVEL pick the thinking budget" },
  { name: "EFFORT_STREAK", def: "1",
    doc: "consecutive requests a level must hold before it is applied" },
  { name: "TIER_MODE", def: "follow",
    doc: "follow | distinct - whether /model tiers share the primary or take a model each" },
  { name: "TIER_OPUS", def: "unset", doc: "pin the Opus tier to a model id" },
  { name: "TIER_SONNET", def: "unset", doc: "pin the Sonnet tier to a model id" },
  { name: "TIER_HAIKU", def: "unset", doc: "pin the Haiku tier to a model id" },
  { name: "CAPTURE_DIR", def: "unset",
    doc: "record request bodies here. Use /captures in the container; they contain your " +
      "prompts and paths, so scrub before sharing" },
  { name: "LOG_LEVEL", def: "info", doc: "debug | info | warn | error" },
  { name: "NO_BANNER", def: "0", doc: "suppress the configuration block printed at startup" },
  { name: "KEEPALIVE_MS", def: "10000", doc: "gap between SSE keepalives during a model swap" },
  { name: "STREAM_WATCHDOG_MS", def: "300000",
    doc: "Claude Code abandons a stream silent this long; stay under it" },
  { name: "BACKEND_PORT", def: "8080", doc: "port llama-server is spawned on, loopback only" },
  // Set by the image. Listed because a bind-mounted catalog or model cache is a
  // supported thing to do, and nothing else would tell you the variable names.
  { name: "MODELS_CONFIG", def: "/app/config/models.yaml", doc: "path to the model catalog" },
  { name: "LLAMA_CACHE", def: "/models", doc: "where weights are downloaded and cached" },
  { name: "LLAMA_SERVER_BIN", def: "/usr/local/bin/llama-server", doc: "llama-server binary" },
  { name: "GATEWAY_ROOT", def: "/app", doc: "base for relative paths" },
];

/**
 * Worked invocations for `GET /admin/config`.
 *
 * A list of variables tells you what exists, not which ones matter together. These are
 * the combinations that actually come up, written so they can be pasted. Every one has
 * been run against this image.
 */
export const EXAMPLES: ReadonlyArray<{ what: string; run: string; why: string }> = [
  {
    what: "normal use",
    run:
      "docker run -d --gpus all -p 8787:8787 -v llm-models:/models claude-code-local-llm",
    why: "GPU, weights kept in a named volume so an image upgrade does not re-download them",
  },
  {
    what: "enforce tool pruning for every client",
    run:
      "docker run -d --gpus all -p 8787:8787 -v llm-models:/models " +
      "-e TOOL_PROFILE=coding claude-code-local-llm",
    why:
      "measured on the 64K model: unpruned, 38.7K of tool schemas left 5.7K for the " +
      "conversation and it compacted every few turns; pruned, 24.7K and it never did. " +
      "Prefer `claude --tools \"...\"` per session; use this when the launch command is " +
      "not yours to change",
  },
  {
    what: "reachable from another machine",
    run:
      "docker run -d --gpus all -p 8787:8787 -v llm-models:/models " +
      "-e GATEWAY_API_KEY=$(openssl rand -hex 24) claude-code-local-llm",
    why:
      "setting the key turns authentication on by itself. Do this before publishing the " +
      "port: unauthenticated, anyone who can reach it can load models onto your GPU",
  },
  {
    what: "no GPU, just to look at it",
    run:
      "docker run -d -p 8787:8787 -v llm-models:/models -e ALLOW_CPU=1 claude-code-local-llm",
    why:
      "prefill is ~18 tok/s, so a realistic Claude Code prompt needs ~370s and the client " +
      "gives up at 300s. Fine for poking the endpoints, not for real sessions",
  },
  {
    what: "capture what the client actually sends",
    run:
      "docker run -d --gpus all -p 8787:8787 -v llm-models:/models -v caps:/captures " +
      "-e CAPTURE_DIR=/captures -e LOG_LEVEL=debug claude-code-local-llm",
    why:
      "how every client quirk documented at " + REPO + " was found. /captures is " +
      "pre-created and owned " +
      "by the gateway user; the files contain your prompts and paths, so scrub before sharing",
  },
  {
    what: "Docker Desktop, where the Run button gives no GPU",
    run: "docker compose up -d",
    why:
      "compose reserves the GPU for you. The Run button passes no --gpus flag and cannot " +
      "be given one afterwards, so a container created with it never gets a GPU. To fix " +
      'that button for good, add "default-runtime": "nvidia" under Settings > Docker Engine',
  },
  {
    what: "WSL2 reporting the wrong amount of RAM",
    run:
      "docker run -d --gpus all -p 8787:8787 -v llm-models:/models " +
      "-e MEMORY_BUDGET_GB=8 claude-code-local-llm",
    why:
      "the gateway reads the cgroup limit, but under Docker Desktop the ceiling that binds " +
      "is the WSL2 VM's share of host RAM, which neither the cgroup nor os.totalmem() reports",
  },
];

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
    tierMode: envEnum("TIER_MODE", ["follow", "distinct"] as const, "follow"),
    tierOpus: process.env.TIER_OPUS?.trim() || null,
    tierSonnet: process.env.TIER_SONNET?.trim() || null,
    tierHaiku: process.env.TIER_HAIKU?.trim() || null,
    toolProfile: process.env.TOOL_PROFILE ?? null,
    captureDir: process.env.CAPTURE_DIR ?? null,
    logLevel: envEnum("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };
}
