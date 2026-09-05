/**
 * Model registry: the catalog of local models this gateway can serve.
 *
 * Model ids must thread a needle between two Claude Code behaviours that pull in
 * opposite directions. Both fail SILENTLY, so both are hard startup errors here.
 *
 *   1. DISCOVERY. Claude Code keeps a model from /v1/models only if its id CONTAINS
 *      "claude" or "anthropic", case-insensitively. Anything else never appears in
 *      the /model picker - no error, no log.
 *
 *   2. CONTEXT WINDOW. CLAUDE_CODE_MAX_CONTEXT_TOKENS is how you declare a local
 *      model's real window so auto-compact fires in time. It applies directly only
 *      when the id does NOT start with "claude-" and contains no "[1m]". For an id
 *      that DOES start with "claude-", the variable takes effect only alongside
 *      DISABLE_COMPACT, which turns compaction off altogether. Left uncorrected,
 *      Claude Code assumes a 200K window for an unrecognised id and will happily
 *      grow a conversation far past what a 16K-context local model can accept.
 *
 * So: contain "claude", never lead with "claude-". `local-claude-qwen3.5-9b` is fine;
 * `claude-qwen3.5-9b` satisfies discovery and then silently breaks compaction.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { GatewayError } from "./anthropic/errors.ts";
import { checkFit } from "./resources.ts";
import type { EffortLevel, HostResources, ModelEntry } from "./types.ts";

const CLAUDE_ID_RE = /claude|anthropic/i;
const LEADING_CLAUDE_RE = /^claude-/i;
const BRACKET_1M_RE = /\[1m\]/i;
const VALID_TIERS = new Set(["vram", "offload", "stretch"]);

export interface ResolvedModel extends ModelEntry {
  available: boolean;
  unavailableReason?: string;
  /** llama-server --alias value; kept identical to `id` so upstream logs line up. */
  alias: string;
  /** Effective thinking budget. Mutable at runtime via setReasoningBudget. */
  reasoningBudget: number;
}

/** Unrestricted thinking. Allowed, but it will eat a small context window alive. */
export const REASONING_UNRESTRICTED = -1;

/**
 * A sensible thinking budget for a model nobody has configured.
 *
 * Reasoning models emit their chain of thought into the SAME context the prompt and the
 * answer share, so on a local model an unrestricted budget is not a luxury setting - it
 * is how a 64-token reply turns into 64 tokens of thinking and no answer, which is
 * exactly what a container test produced before this existed.
 *
 * An eighth of the window leaves room to think without crowding out the conversation,
 * and the 4096 cap stops a large-context model from reserving more than it can usefully
 * spend. A model whose template has no thinking mode gets 0, because a budget there is
 * meaningless.
 */
export function defaultReasoningBudget(entry: ModelEntry): number {
  if (!entry.capabilities?.includes("thinking")) return 0;
  return Math.min(4096, Math.floor((entry.context ?? 0) / 8));
}

/**
 * The range an operator may choose from for this model.
 *
 * Half the window is the ceiling because past that the prompt and the answer have
 * nowhere to live - the model would think itself out of room to respond.
 */
export function reasoningRange(entry: ModelEntry): { min: number; max: number } {
  return { min: REASONING_UNRESTRICTED, max: Math.floor((entry.context ?? 0) / 2) };
}

/**
 * Translate Claude Code's effort level into a thinking budget for this model.
 *
 * Claude Code sends `output_config.effort` on every request, set by the user through
 * CLAUDE_CODE_EFFORT_LEVEL. It is already five discrete levels, so it maps onto a
 * budget ladder directly - there is nothing to quantise, and no jitter to debounce.
 *
 * The ladder doubles at each step and is anchored so that `high`, which is both the API
 * default and what Claude Code sends when the user has expressed no preference, lands
 * exactly on the budget the model would have had anyway. Changing nothing therefore
 * changes nothing. `max` reaches the enforced ceiling of half the window; past that the
 * prompt and the answer have nowhere to live.
 *
 * `thinking` cannot serve this purpose even though Claude Code also sends it: it arrives
 * as {"type":"adaptive"} and carries no number at all.
 */
export function budgetForEffort(entry: ModelEntry, effort: EffortLevel): number {
  if (!entry.capabilities?.includes("thinking")) return 0;

  const { max: ceiling } = reasoningRange(entry);
  const context = entry.context ?? 0;
  const clamp = (n: number): number => Math.max(0, Math.min(ceiling, Math.floor(n)));

  switch (effort) {
    case "low":
      return clamp(context / 32);
    case "medium":
      return clamp(context / 16);
    case "high":
      // The no-preference case: keep the model's own default rather than recomputing it.
      return clamp(defaultReasoningBudget(entry));
    case "xhigh":
      return clamp(context / 4);
    case "max":
      return ceiling;
  }
}

export class Registry {
  private readonly byId = new Map<string, ResolvedModel>();
  private defaultId: string | null = null;

  private constructor(models: ResolvedModel[]) {
    for (const m of models) this.byId.set(m.id.toLowerCase(), m);
    this.defaultId = Registry.pickDefault(models);
  }

  /**
   * Choose the model every unresolved id falls back to.
   *
   * The catalog's `default: true` only wins if it can actually LOAD here. It used to
   * win unconditionally, which broke the constrained hosts it most needed to serve: on
   * a machine where the default does not fit, `resolve()` handed it back for every
   * unrecognised id, and since Claude Code's background slot always sends one of those,
   * a session spent itself on 400s naming a model that was never going to run.
   *
   * When the marked default cannot run, take the LARGEST model that can. Size tracks
   * quality closely enough within one catalog, and the alternative - first in file
   * order - makes the choice depend on how the YAML happens to be sorted. The
   * substitution is logged by the caller, never silent.
   */
  private static pickDefault(models: ResolvedModel[]): string | null {
    const marked = models.find((m) => m.default);
    if (marked && marked.available) return marked.id;

    const largestAvailable = models
      .filter((m) => m.available)
      .sort((a, b) => b.size_gb - a.size_gb)[0];
    if (largestAvailable) return largestAvailable.id;

    // Nothing fits. Keep a default anyway so /v1/models and /admin/client-env still
    // answer with something coherent; every load attempt will fail with the shortfall.
    return marked?.id ?? models[0]?.id ?? null;
  }

  /** The catalog's `default: true`, whether or not it can run. For startup logging. */
  getMarkedDefaultId(): string | null {
    return [...this.byId.values()].find((m) => m.default)?.id ?? null;
  }

  static async load(
    path: string,
    res: HostResources,
    envDefaultBudget?: number | null,
  ): Promise<Registry> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(`cannot read model registry at ${path}: ${(err as Error).message}`);
    }

    const doc = parseYaml(raw) as { models?: ModelEntry[] } | null;
    const entries = doc?.models;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`model registry ${path} has no \`models:\` entries`);
    }

    const problems: string[] = [];
    const seen = new Set<string>();
    const resolved: ResolvedModel[] = [];

    for (const [i, e] of entries.entries()) {
      const where = `models[${i}]${e?.id ? ` (${e.id})` : ""}`;

      if (!e?.id || typeof e.id !== "string") {
        problems.push(`${where}: missing \`id\``);
        continue;
      }
      if (!CLAUDE_ID_RE.test(e.id)) {
        problems.push(
          `${where}: id must contain "claude" or "anthropic" - Claude Code silently ` +
            `drops every other id from the /model picker. Try "local-claude-${e.id}".`,
        );
      }
      if (LEADING_CLAUDE_RE.test(e.id)) {
        problems.push(
          `${where}: id must not START with "claude-". Such an id makes ` +
            `CLAUDE_CODE_MAX_CONTEXT_TOKENS inert unless DISABLE_COMPACT is also set, ` +
            `so Claude Code assumes a 200K context window and never compacts in time ` +
            `for a local model. Try "local-${e.id}".`,
        );
      }
      if (BRACKET_1M_RE.test(e.id)) {
        problems.push(
          `${where}: id must not contain "[1m]" - Claude Code then assumes a 1M ` +
            `context window and ignores CLAUDE_CODE_MAX_CONTEXT_TOKENS.`,
        );
      }
      if (seen.has(e.id.toLowerCase())) {
        problems.push(`${where}: duplicate id`);
      }
      seen.add(e.id.toLowerCase());

      if (!e.hf && !e.path) {
        problems.push(`${where}: needs either \`hf\` or \`path\``);
      }
      if (e.hf && e.path) {
        problems.push(`${where}: set \`hf\` or \`path\`, not both`);
      }
      if (typeof e.size_gb !== "number" || e.size_gb <= 0) {
        problems.push(`${where}: \`size_gb\` must be a positive number`);
      }
      if (typeof e.context !== "number" || e.context <= 0) {
        problems.push(`${where}: \`context\` must be a positive number`);
      }
      if (!VALID_TIERS.has(e.tier)) {
        problems.push(`${where}: \`tier\` must be one of vram|offload|stretch`);
      }
      if (!Array.isArray(e.capabilities)) {
        problems.push(`${where}: \`capabilities\` must be a list`);
      }

      // Catalog value wins, then the operator's global default, then the derived one.
      let budget = e.reasoning_budget ?? envDefaultBudget ?? defaultReasoningBudget(e);
      if (!Number.isInteger(budget) || budget < REASONING_UNRESTRICTED) {
        problems.push(
          `${where}: \`reasoning_budget\` must be an integer >= -1 ` +
            `(-1 unrestricted, 0 off), got ${JSON.stringify(budget)}`,
        );
        budget = 0;
      } else {
        const { max } = reasoningRange(e);
        if (budget > max) {
          problems.push(
            `${where}: \`reasoning_budget\` ${budget} exceeds half this model's ` +
              `${e.context}-token window (${max}); the prompt and the answer would ` +
              `have nowhere left to go`,
          );
        }
      }

      const fit = checkFit(e.size_gb ?? 0, e.tier ?? "vram", res);
      resolved.push({
        ...e,
        alias: e.id,
        available: fit.fits,
        reasoningBudget: budget,
        ...(fit.fits ? {} : { unavailableReason: fit.note }),
      });
    }

    const defaults = resolved.filter((m) => m.default);
    if (defaults.length > 1) {
      problems.push(
        `more than one model marked \`default: true\`: ${defaults.map((m) => m.id).join(", ")}`,
      );
    }

    if (problems.length > 0) {
      throw new Error(
        `invalid model registry (${path}):\n` + problems.map((p) => `  - ${p}`).join("\n"),
      );
    }

    return new Registry(resolved);
  }

  get(id: string): ResolvedModel | undefined {
    return this.byId.get(id.toLowerCase());
  }

  /**
   * Resolve the model a request asked for.
   *
   * Claude Code sends real Anthropic ids (claude-sonnet-4-5, claude-haiku-4-5, ...)
   * unless the user overrode them, and those will not match our catalog. Rather than
   * 404 - which surfaces as an opaque failure mid-session - an unknown id falls back
   * to the default model. That is what makes `ANTHROPIC_BASE_URL=... && claude` work
   * with no further configuration.
   */
  resolve(id: string | undefined): { model: ResolvedModel; fellBack: boolean } {
    if (id) {
      const exact = this.get(id);
      if (exact) return { model: exact, fellBack: false };
    }
    const fallback = this.defaultId ? this.get(this.defaultId) : undefined;
    if (!fallback) {
      throw GatewayError.internal("model registry is empty");
    }
    return { model: fallback, fellBack: true };
  }

  /**
   * Change a model's thinking budget at runtime.
   *
   * The value only reaches llama-server through spawn arguments, so it takes effect on
   * the next load rather than immediately - the caller is responsible for deciding
   * whether to evict the running backend. Returning the range on rejection means the
   * caller can tell the operator what they were allowed to ask for.
   */
  setReasoningBudget(id: string, budget: number): ResolvedModel {
    const model = this.get(id);
    if (!model) {
      throw GatewayError.notFound("no model with id " + id);
    }
    const { min, max } = reasoningRange(model);
    if (!Number.isInteger(budget) || budget < min || budget > max) {
      throw GatewayError.invalidRequest(
        "reasoning budget must be an integer between " + min + " and " + max +
          " for " + model.id + " (-1 unrestricted, 0 off; the ceiling is half its " +
          model.context + "-token window)",
      );
    }
    if (budget !== 0 && !model.capabilities.includes("thinking")) {
      throw GatewayError.invalidRequest(
        model.id + " has no thinking mode in its chat template, so a budget above 0 " +
          "would do nothing",
      );
    }
    model.reasoningBudget = budget;
    return model;
  }

  list(): ResolvedModel[] {
    return [...this.byId.values()];
  }

  getDefaultId(): string | null {
    return this.defaultId;
  }
}
