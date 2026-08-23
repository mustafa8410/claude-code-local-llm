/**
 * Per-process request context: the objects handlers need, plus the two policy
 * decisions that do not belong to any single handler.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./log.ts";
import { GatewayError } from "./anthropic/errors.ts";
import type { Config } from "./config.ts";
import type { Registry, ResolvedModel } from "./registry.ts";
import type { Supervisor } from "./supervisor.ts";
import type { MessagesRequest } from "./types.ts";

export class RequestContext {
  private captureSeq = 0;

  // Explicit fields rather than parameter properties: Node's strip-only TypeScript
  // mode cannot transform the latter, and dev runs the sources directly.
  readonly config: Config;
  readonly registry: Registry;
  readonly supervisor: Supervisor;

  constructor(config: Config, registry: Registry, supervisor: Supervisor) {
    this.config = config;
    this.registry = registry;
    this.supervisor = supervisor;
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
      .catch((err: Error) => log.warn("capture failed", { err: err.message }));
  }
}
