/**
 * Per-process request context: the objects handlers need, plus the two policy
 * decisions that do not belong to any single handler.
 */

import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { log } from "./log.ts";
import { GatewayError } from "./anthropic/errors.ts";
import type { Config } from "./config.ts";
import type { Registry, ResolvedModel } from "./registry.ts";
import type { Supervisor } from "./supervisor.ts";
import { readEffort, type EffortLevel, type HostResources, type MessagesRequest } from "./types.ts";
import { budgetForEffort } from "./registry.ts";

/**
 * Prove the capture directory is usable, at startup, before anything relies on it.
 *
 * Capture writes are fire-and-forget - a failure is one log line arriving long after
 * the operator has stopped watching, so an unusable directory reads as "capture just
 * doesn't work". The obvious container invocation hits exactly that: the gateway runs
 * as a non-root user and cannot create a directory at the filesystem root, so
 * `CAPTURE_DIR=/captures` fails permission-denied on a path the image now pre-creates
 * for precisely this reason.
 *
 * Writing and deleting a probe file catches the permission case that mkdir alone
 * misses: a directory that already exists but belongs to somebody else.
 */
export async function ensureCaptureDir(dir: string): Promise<void> {
  const probe = path.join(dir, ".capture-probe");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
  } catch (err) {
    throw new Error(
      "CAPTURE_DIR " + dir + " is not writable: " + (err as Error).message +
        ". In the container use /captures (pre-created for the gateway user) or a " +
        "path under /models; a directory the image does not own cannot be created " +
        "by a non-root process.",
    );
  }
}

export class RequestContext {
  private captureSeq = 0;
  /** Consecutive requests seen at one effort level. See applyClientEffort. */
  private effortRun: { level: EffortLevel; count: number } | null = null;

  // Explicit fields rather than parameter properties: Node's strip-only TypeScript
  // mode cannot transform the latter, and dev runs the sources directly.
  readonly config: Config;
  readonly registry: Registry;
  readonly supervisor: Supervisor;
  /** Probed once at startup; a model added at runtime is sized against it. */
  readonly resources: HostResources;

  constructor(
    config: Config,
    registry: Registry,
    supervisor: Supervisor,
    resources: HostResources,
  ) {
    this.config = config;
    this.registry = registry;
    this.supervisor = supervisor;
    this.resources = resources;
  }

  /**
   * Decide which model actually gets loaded for this request.
   *
   * Claude Code drives TWO model slots: the main model, and a background model for
   * side tasks like conversation titling. On a single-GPU host those slots fight -
   * every background request evicts the main model and every main request evicts it
   * back, so a session spends all its time swapping instead of answering.
   *
   * The signal for "this is background traffic" is `fellBack`: the id was not in our
   * registry. That is precisely the case in practice, because the background slot
   * defaults to a real Anthropic id (claude-haiku-*) that a local catalog never
   * contains, while the main slot is something the user deliberately selected.
   *
   * An earlier version inferred it from request SHAPE - no tools, small max_tokens,
   * few messages - and that was wrong: a short tool-free prompt to an explicitly
   * chosen model looks identical, so the gateway silently answered from a different
   * model than the one named in /model. An explicit choice is now always honoured.
   */
  chooseTarget(requested: ResolvedModel, fellBack: boolean): ResolvedModel {
    // The id resolved exactly: the caller asked for this model by name. Honour it.
    if (!fellBack) return requested;

    const loadedId = this.supervisor.currentModelId();
    if (loadedId === null || loadedId === requested.id) return requested;

    switch (this.config.backgroundStrategy) {
      case "reuse-primary": {
        const loaded = this.registry.get(loadedId);
        if (loaded) {
          log.debug("unrecognised model id served from loaded model", {
            requested: requested.id,
            serving: loaded.id,
          });
          return loaded;
        }
        return requested;
      }
      case "reject":
        throw GatewayError.invalidRequest(
          "model id was not recognised and BACKGROUND_STRATEGY=reject forbids " +
            "falling back to the loaded model (" + loadedId + ")",
        );
      case "swap":
      default:
        return requested;
    }
  }

  /**
   * Let the client's chosen effort level pick this model's thinking budget.
   *
   * Claude Code sends `output_config.effort` on every request and the user sets it with
   * CLAUDE_CODE_EFFORT_LEVEL, so this is the one reasoning dial that reaches us with the
   * user's actual intent on it. `thinking` does not qualify - it arrives as
   * {"type":"adaptive"} with no number, and llama-server ignores it regardless.
   *
   * The budget only takes effect at spawn time, so a change means evicting the running
   * backend. That is why this is opt-in: paying a reload when someone deliberately turns
   * a dial is reasonable, paying one because the client jittered a level between two
   * requests is not. Returns whether the backend was evicted so the caller can recompute
   * whether it now needs to wait for a load.
   */
  applyClientEffort(target: ResolvedModel, body: MessagesRequest): Promise<boolean> {
    if (!this.config.effortFollowsClient) return Promise.resolve(false);

    const effort = readEffort(body);
    if (effort === null) return Promise.resolve(false);

    // Optional hysteresis: act only on a level that has held for N requests in a row.
    //
    // effortStreak defaults to 1, so by default the user's level applies immediately.
    // It was 3, after a soak phase logged 36 effort changes and 35 reloads - but that
    // delay was the wrong tool. Someone who exports CLAUDE_CODE_EFFORT_LEVEL sends the
    // same level on every request, so a streak does not avoid the reload, it only
    // postpones it, serving N-1 requests at a budget the user did not ask for. It helps
    // only against alternation, and effort handling was never confirmed as the source of
    // that alternation - a rerun did not reproduce it. The knob remains for anyone who
    // meets a genuinely alternating client.
    if (this.effortRun !== null && this.effortRun.level === effort) {
      this.effortRun.count += 1;
    } else {
      this.effortRun = { level: effort, count: 1 };
    }
    if (this.effortRun.count < this.config.effortStreak) {
      log.debug("effort level not yet stable; ignoring", {
        effort,
        seen: this.effortRun.count,
        needs: this.config.effortStreak,
      });
      return Promise.resolve(false);
    }

    const wanted = budgetForEffort(target, effort);
    if (wanted === target.reasoningBudget) return Promise.resolve(false);

    const previous = target.reasoningBudget;
    target.reasoningBudget = wanted;
    log.info("client effort changed the thinking budget", {
      model: target.id,
      effort,
      from: previous,
      to: wanted,
    });

    // Only a loaded backend has to go; if nothing is serving this model the next load
    // picks the new value up for free.
    if (this.supervisor.currentModelId() !== target.id) return Promise.resolve(false);
    return this.supervisor.stop().then(() => true);
  }

  /**
   * Persist a request body for contract tests. Recorded traffic is the only reliable
   * description of what Claude Code actually sends, since the field set grows with
   * each release.
   */
  capture(body: MessagesRequest): void {
    const dir = this.config.captureDir;
    if (!dir) return;
    const seq = ++this.captureSeq;
    const file = path.join(dir, "req-" + String(seq).padStart(4, "0") + ".json");
    void mkdir(dir, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(body, null, 2), "utf8"))
      // error, not warn: a silent capture is a debugging session that produces nothing
      // and gives no clue why. ensureCaptureDir should have caught this at startup.
      .catch((err: Error) => log.error("capture failed", { dir, err: err.message }));
  }
}
