/**
 * Tool-schema pruning.
 *
 * In a measured Claude Code request, tool definitions were 81% of the payload -
 * roughly 23,400 of 28,800 tokens - while the system prompt was only 6%. On a model
 * holding 16-32K of context that single fact decides whether a session works.
 *
 * The supported fix is client-side: `claude --tools "Read,Glob,Grep,Bash"`, measured
 * at a 73% reduction. Prefer it. This module exists for the case where the launch
 * command cannot be changed - a shared container, a script someone else owns.
 *
 * PRUNING MUST BE DETERMINISTIC. llama.cpp reuses its prompt cache only across a
 * stable token prefix, so a filter that reorders tools between requests would defeat
 * the very cache it is meant to help. Input order is preserved and selection depends
 * on nothing but the tool name.
 */

import type { ToolDef } from "../types.ts";

/**
 * Named profiles. Values are matched case-insensitively against tool names, so both
 * built-in tools and MCP tools (`mcp__server__tool`) can be selected.
 */
const PROFILES: Record<string, readonly string[]> = {
  // Read-only investigation. Smallest useful surface.
  analysis: ["read", "glob", "grep", "bash", "powershell", "todowrite"],
  // Everyday editing.
  coding: [
    "read", "glob", "grep", "bash", "powershell",
    "write", "edit", "todowrite", "notebookedit",
  ],
};

export function availableProfiles(): string[] {
  return [...Object.keys(PROFILES), "full"];
}

/**
 * @param profile one of `full`, a named profile, or a comma-separated tool list.
 */
export function pruneTools(
  tools: ToolDef[] | undefined,
  profile: string | null,
): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return tools;
  if (!profile || profile === "full") return tools;

  const allow = resolveAllowList(profile);
  if (allow === null) return tools;

  // Order preserved; membership is a pure function of the name. Both properties are
  // required for the upstream prompt cache to survive across turns.
  return tools.filter((t) => typeof t.name === "string" && allow.has(t.name.toLowerCase()));
}

function resolveAllowList(profile: string): Set<string> | null {
  const named = PROFILES[profile.toLowerCase()];
  if (named) return new Set(named);

  if (profile.includes(",")) {
    const custom = profile
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    return custom.length > 0 ? new Set(custom) : null;
  }
  return null;
}

/**
 * Is this a value pruneTools can act on?
 *
 * Worth having separately because an unrecognised value used to be a SILENT no-op:
 * `TOOL_PROFILE=codng` resolved to null, pruneTools returned the tools untouched, and
 * nothing said so. On a window too small for the full tool set that surfaces much
 * later as `prompt is too long`, which points nowhere near the typo. Callers use this
 * to complain at startup and fall back, rather than quietly doing nothing.
 *
 * Note that a bare single word is NOT accepted as a one-tool list. `TOOL_PROFILE=Read`
 * is far more likely to be a mistyped profile name than a genuine wish for exactly one
 * tool, and reading it as a list would prune everything else away - a worse failure
 * than refusing it. Write `Read,Grep` for a list, or `Read,` for a list of one.
 */
export function isKnownProfile(profile: string): boolean {
  const p = profile.trim();
  if (p === "" || p.toLowerCase() === "full") return true;
  return resolveAllowList(p) !== null;
}

/** The named profiles and their members, for error messages and docs. */
export function describeProfiles(): Record<string, readonly string[]> {
  return { ...PROFILES };
}
