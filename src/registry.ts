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
import type { HostResources, ModelEntry } from "./types.ts";

const CLAUDE_ID_RE = /claude|anthropic/i;
const LEADING_CLAUDE_RE = /^claude-/i;
const BRACKET_1M_RE = /\[1m\]/i;
const VALID_TIERS = new Set(["vram", "offload", "stretch"]);

export interface ResolvedModel extends ModelEntry {
  available: boolean;
  unavailableReason?: string;
  /** llama-server --alias value; kept identical to `id` so upstream logs line up. */
  alias: string;
}

export class Registry {
  private readonly byId = new Map<string, ResolvedModel>();
  private defaultId: string | null = null;

  private constructor(models: ResolvedModel[]) {
    for (const m of models) this.byId.set(m.id.toLowerCase(), m);
    this.defaultId = models.find((m) => m.default)?.id
      ?? models.find((m) => m.available)?.id
      ?? models[0]?.id
      ?? null;
  }

  static async load(path: string, res: HostResources): Promise<Registry> {
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

      const fit = checkFit(e.size_gb ?? 0, e.tier ?? "vram", res);
      resolved.push({
        ...e,
        alias: e.id,
        available: fit.fits,
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

  list(): ResolvedModel[] {
    return [...this.byId.values()];
  }

  getDefaultId(): string | null {
    return this.defaultId;
  }
}
