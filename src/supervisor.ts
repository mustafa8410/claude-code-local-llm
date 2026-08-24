/**
 * llama-server lifecycle.
 *
 * 8 GB of VRAM holds exactly one model, so serving a catalog means stopping one
 * backend and starting another. That is the expensive, failure-prone operation this
 * class exists to make safe:
 *
 *   - single-flight: twenty concurrent requests for the same model produce ONE spawn
 *   - the driver frees VRAM some time AFTER the previous process exits, so a spawn
 *     can hit a CUDA OOM; we settle briefly and retry rather than trusting a probe
 *     (see settleAfterExit for why polling free VRAM does not work here)
 *   - readiness is gated on /health, which answers 503 "Loading model" and only
 *     later 200 {"status":"ok"}
 *   - callers get progress callbacks so an HTTP handler can keep a stream alive
 *     while all of this happens
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { listGpuDevices } from "./resources.ts";
import { log } from "./log.ts";
import type { ResolvedModel } from "./registry.ts";
import type { Config } from "./config.ts";
import { GatewayError } from "./anthropic/errors.ts";

export type SupervisorState =
  | "idle"
  | "downloading"
  | "loading"
  | "ready"
  | "draining"
  | "stopping";

export interface SupervisorStatus {
  state: SupervisorState;
  modelId: string | null;
  since: number;
  lastMessage: string;
  inflight: number;
  spawnCount: number;
  swapCount: number;
}

export type ProgressFn = (message: string) => void;

const HEALTH_POLL_MS = 500;
/** Generous on purpose: a cold first run downloads several GB before loading. */
const LOAD_TIMEOUT_MS = 15 * 60_000;
const EXIT_GRACE_MS = 10_000;
/** Pause after backend exit so the driver can reclaim VRAM before the next spawn. */
const VRAM_SETTLE_MS = 2_000;
/** A spawn that dies on a CUDA OOM is retried this many times, backing off. */
const OOM_RETRIES = 3;
const OOM_BACKOFF_MS = 4_000;
const PROGRESS_INTERVAL_MS = 5_000;

export class Supervisor {
  private state: SupervisorState = "idle";
  private stateSince = Date.now();
  private lastMessage = "not started";
  private child: ChildProcess | null = null;
  private current: ResolvedModel | null = null;
  private inflight = 0;
  private spawnCount = 0;
  private swapCount = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail: string[] = [];

  /** In-flight swap keyed by target id. Makes concurrent ensure() single-flight. */
  private pending: { id: string; promise: Promise<void> } | null = null;

  // Explicit field + assignment rather than a parameter property: Node's strip-only
  // TypeScript mode cannot transform parameter properties, and we want `node
  // src/server.ts` to run the sources directly during development.
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  get backendUrl(): string {
    return "http://127.0.0.1:" + this.cfg.backendPort;
  }

  status(): SupervisorStatus {
    return {
      state: this.state,
      modelId: this.current ? this.current.id : null,
      since: this.stateSince,
      lastMessage: this.lastMessage,
      inflight: this.inflight,
      spawnCount: this.spawnCount,
      swapCount: this.swapCount,
    };
  }

  currentModelId(): string | null {
    return this.current ? this.current.id : null;
  }

  recentLogs(): string[] {
    return this.stderrTail.slice();
  }

  private setState(state: SupervisorState, message: string): void {
    this.state = state;
    this.stateSince = Date.now();
    this.lastMessage = message;
    log.info("supervisor state", {
      state,
      message,
      model: this.current ? this.current.id : "-",
    });
  }

  /**
   * Guarantee that `model` is loaded and serving, swapping if necessary.
   * Concurrent callers targeting the same model share one swap.
   */
  async ensure(model: ResolvedModel, onProgress?: ProgressFn): Promise<void> {
    if (!model.available) {
      const why = model.unavailableReason ?? "insufficient memory";
      throw GatewayError.invalidRequest(
        "model " + model.id + " cannot run on this host: " + why,
      );
    }

    if (this.isServing(model.id)) return;

    // Drain EVERY in-flight swap, not just the first one observed.
    //
    // Checking `pending` once was not enough. With a load for A in flight and requests
    // for B and C both parked on its promise, A settles, both continuations resume,
    // both find `waitingFor !== their id`, and both fall through to start a swap - two
    // llama-server processes racing onto one GPU, which is the exact CUDA OOM this
    // class exists to prevent. Re-checking in a loop means the second waiter observes
    // the first one's swap and parks on that instead.
    while (this.pending) {
      const inFlight = this.pending;
      onProgress?.("waiting for in-flight load of " + inFlight.id);
      await inFlight.promise.catch(() => undefined);
      if (this.isServing(model.id)) return;
      // Nobody queued a new swap while we waited, so it is our turn.
      if (this.pending === inFlight) break;
    }

    if (this.isServing(model.id)) return;

    const promise = this.swapTo(model, onProgress).finally(() => {
      if (this.pending && this.pending.id === model.id) this.pending = null;
    });
    this.pending = { id: model.id, promise };
    return promise;
  }

  private isServing(id: string): boolean {
    return this.state === "ready" && this.current !== null && this.current.id === id;
  }

  /**
   * Whether a request for `id` can be served right now with no wait. Callers use
   * this to decide whether they must commit SSE headers early and emit keepalives.
   */
  isReadyFor(id: string): boolean {
    return this.isServing(id);
  }

  private async swapTo(model: ResolvedModel, onProgress?: ProgressFn): Promise<void> {
    const from = this.current ? this.current.id : null;
    if (from !== null) {
      this.swapCount++;
      onProgress?.("unloading " + from);
      await this.stop();
      onProgress?.("waiting for VRAM release");
      await this.settleAfterExit();
    }
    onProgress?.("starting " + model.id);
    await this.startWithOomRetry(model, onProgress);
  }

  /**
   * Spawn, retrying if the backend dies because the previous model's VRAM had not
   * been reclaimed yet. This is what makes the fixed settle delay safe: too short a
   * pause costs a retry rather than failing the request.
   */
  private async startWithOomRetry(
    model: ResolvedModel,
    onProgress?: ProgressFn,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.start(model, onProgress);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= OOM_RETRIES || !isOutOfMemory(message)) throw err;
        const waitMs = OOM_BACKOFF_MS * (attempt + 1);
        log.warn("backend hit an out-of-memory error; retrying", {
          model: model.id,
          attempt: attempt + 1,
          waitMs,
        });
        onProgress?.("GPU memory still held by the previous model; retrying");
        await this.stop();
        await sleep(waitMs);
      }
    }
  }

  private buildArgs(model: ResolvedModel): string[] {
    const args: string[] = [];
    if (model.hf) args.push("-hf", model.hf);
    else if (model.path) args.push("-m", model.path);

    args.push(
      "--alias", model.alias,
      "--host", "127.0.0.1",
      "--port", String(this.cfg.backendPort),
      // The backend credential goes in the environment, not here - see start(). On
      // argv it is readable by any local process via `ps`, and it would also land in
      // the "spawn" log line below, which we print at info level.
      // Tool calling is the entire point. Without --jinja llama-server cannot emit
      // tool_use blocks and Claude Code's agent loop never starts.
      "--jinja",
      "-c", String(model.context),
    );
    if (model.args) args.push(...model.args);
    return args;
  }

  private async start(model: ResolvedModel, onProgress?: ProgressFn): Promise<void> {
    const args = this.buildArgs(model);
    this.current = model;
    this.setState("loading", "spawning llama-server for " + model.id);
    this.stderrTail = [];
    log.info("spawn", { bin: this.cfg.serverBin, args: args.join(" ") });

    const child = spawn(this.cfg.serverBin, args, {
      env: {
        ...process.env,
        LLAMA_CACHE: this.cfg.modelCacheDir,
        // llama-server reads --api-key from LLAMA_API_KEY, which keeps the shared
        // secret out of argv (visible to any local process through `ps`) and out of
        // the spawn log line above.
        LLAMA_API_KEY: this.cfg.backendApiKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.spawnCount++;

    let exited: { code: number | null } | null = null;
    let spawnError: Error | null = null;
    child.on("exit", (code) => {
      exited = { code };
      if (this.child === child) {
        this.child = null;
        if (this.state !== "stopping") {
          this.current = null;
          this.setState("idle", "llama-server exited unexpectedly (code=" + code + ")");
        }
      }
    });
    // Node emits 'error' INSTEAD OF 'exit' when the process could never be spawned at
    // all - a missing binary, a bad path, no execute permission. Only logging it left
    // `exited` null, so the readiness loop below polled a port nothing was listening on
    // for the full 15-minute LOAD_TIMEOUT_MS and then blamed the model for being slow.
    // A typo in LLAMA_SERVER_BIN should fail in milliseconds and say so.
    child.on("error", (err) => {
      spawnError = err;
      log.error("spawn failed", { bin: this.cfg.serverBin, err: err.message });
    });

    const capture = (buf: Buffer) => {
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (t === "") continue;
        this.stderrTail.push(t);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        if (this.state === "loading" && /download|fetching/i.test(t)) {
          this.setState("downloading", "fetching model weights");
        }
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    let lastProgress = 0;

    while (Date.now() < deadline) {
      if (spawnError !== null) {
        const err = spawnError as Error;
        const code = (err as NodeJS.ErrnoException).code;
        // Clear state directly rather than calling stop(). There is no process to
        // terminate - it never started - so stop() would kill a pid that does not
        // exist and then wait out EXIT_GRACE_MS plus the SIGKILL race for an 'exit'
        // event that can never arrive, turning an instant failure into a 15s one.
        this.child = null;
        this.current = null;
        this.setState("idle", "llama-server could not be spawned");
        throw GatewayError.internal(
          "could not start llama-server at " + this.cfg.serverBin + ": " + err.message +
            (code === "ENOENT"
              ? " (binary not found - set LLAMA_SERVER_BIN to its full path)"
              : ""),
        );
      }
      if (exited !== null) {
        const tail = this.stderrTail.slice(-8).join(" | ");
        const code = (exited as { code: number | null }).code;
        throw GatewayError.internal(
          "llama-server exited during startup (code=" + code + "): " + tail,
        );
      }
      if (await this.pollHealth()) {
        this.setState("ready", model.id + " ready");
        this.armIdleTimer();
        return;
      }
      const now = Date.now();
      if (now - lastProgress > PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        onProgress?.(
          this.state === "downloading" ? "downloading weights" : "loading model",
        );
      }
      await sleep(HEALTH_POLL_MS);
    }

    await this.stop();
    throw GatewayError.internal(
      "llama-server failed to become ready within " + LOAD_TIMEOUT_MS + "ms",
    );
  }

  /** true once /health answers 200; 503 means "Loading model" and is expected. */
  private async pollHealth(): Promise<boolean> {
    try {
      const res = await fetch(this.backendUrl + "/health", {
        headers: { authorization: "Bearer " + this.cfg.backendApiKey },
        signal: AbortSignal.timeout(2_000),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.current = null;
      this.setState("idle", "no backend running");
      return;
    }
    this.setState("stopping", "terminating llama-server");
    this.clearIdleTimer();

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill();

    const raced = await Promise.race([
      exited.then(() => "exited" as const),
      sleep(EXIT_GRACE_MS).then(() => "timeout" as const),
    ]);
    if (raced === "timeout") {
      log.warn("llama-server did not exit in time; forcing");
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(5_000)]);
    }

    this.child = null;
    this.current = null;
    this.setState("idle", "backend stopped");
  }

  /**
   * Let the driver reclaim VRAM after the previous backend exits.
   *
   * The obvious implementation - poll free VRAM until it recovers - does not work
   * here. `llama-server --list-devices` was measured reporting an IDENTICAL free
   * figure (7113 MiB) both before and after a 5.5 GB model was resident, so its free
   * number does not reflect other processes' allocations and polling it would spin
   * against a constant. Total VRAM from that probe is still trustworthy, and that is
   * all `checkFit` relies on.
   *
   * So instead: wait for real process exit (already done by stop()), pause briefly
   * for the driver, and let `start()` retry on the OOM if the pause was too short.
   * That is self-correcting and depends on nothing the probe claims.
   */
  private async settleAfterExit(): Promise<void> {
    const devices = await listGpuDevices(this.cfg.serverBin);
    if (devices.length === 0) return; // CPU-only host: nothing to reclaim
    await sleep(VRAM_SETTLE_MS);
  }

  trackStart(): void {
    this.inflight++;
    this.clearIdleTimer();
  }

  trackEnd(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.inflight === 0) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.cfg.idleTtlSeconds <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.inflight === 0 && this.state === "ready") {
        log.info("idle TTL reached; unloading", {
          model: this.current ? this.current.id : "-",
        });
        void this.stop();
      }
    }, this.cfg.idleTtlSeconds * 1000);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * Recognise an allocation failure in llama-server's exit output. Matching on wording
 * is unavoidable here: the process exits with a generic non-zero code and the reason
 * only appears in stderr.
 */
function isOutOfMemory(message: string): boolean {
  return /out of memory|cudaMalloc|CUDA error|failed to allocate|ggml_backend_.*alloc/i
    .test(message);
}
