/**
 * Request shaping between Claude Code and llama-server.
 *
 * The rule is: TOLERANT INBOUND, STRICT OUTBOUND.
 *
 * Inbound we never reject a request for carrying a field we do not recognise -
 * Claude Code adds body fields with each release and rejecting them would break the
 * gateway on somebody else's release schedule. Outbound we build the upstream body
 * from an explicit allowlist, because several fields Claude Code sends are hard 400s
 * at llama-server:
 *
 *   context_management            - context-editing beta
 *   output_config                 - effort / structured outputs / task budget
 *   tools[].strict                - beta tool schema field
 *   tools[].defer_loading         - MCP tool-search beta field
 *   *.cache_control               - prompt-cache markers, meaningless to llama.cpp
 *
 * `thinking` is dropped for a different reason. It was recorded here as a hard 400,
 * and on the current llama.cpp that no longer reproduces - probed directly against the
 * backend, `adaptive`, `disabled` and `enabled`+`budget_tokens` all return 200. They
 * also all return a thinking block of much the same size, including `disabled`, so the
 * field is PARSED AND THEN IGNORED. Forwarding it would advertise a control that does
 * nothing: a user setting MAX_THINKING_TOKENS would see it accepted and disobeyed.
 * Thinking is governed where it actually takes effect - `--reasoning` /
 * `--reasoning-budget` at spawn - so it is set per model and changed through
 * POST /admin/reasoning. See registry.ts:defaultReasoningBudget.
 */

import { GatewayError } from "./anthropic/errors.ts";
import type {
  ContentBlock,
  MessagesRequest,
  Message,
  Role,
  ToolDef,
} from "./types.ts";

/** Top-level fields we forward. Everything else is dropped, by design. */
const FORWARDED_FIELDS = [
  "messages",
  "system",
  "max_tokens",
  "stop_sequences",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "tool_choice",
] as const;

function stripCacheControl<T extends Record<string, unknown>>(obj: T): T {
  if (!("cache_control" in obj)) return obj;
  const { cache_control: _drop, ...rest } = obj;
  return rest as T;
}

function sanitizeBlock(block: ContentBlock): ContentBlock | null {
  // `tool_reference` blocks belong to the MCP tool-search beta and reference a tool
  // definition we may have pruned. Forwarding one yields a dangling reference.
  if (block.type === "tool_reference") return null;
  return stripCacheControl(block as Record<string, unknown>) as ContentBlock;
}

/**
 * Coerce a message role into one every chat template accepts.
 *
 * Claude Code appends a `role: "system"` message to the END of messages[] partway
 * through a session. Strict Jinja templates reject that outright - Qwen3.5 raises
 * "System message must be at the beginning" and llama-server returns a 500. Observed
 * in practice: Claude Code then retried the identical request ELEVEN times, because
 * a raw Jinja error is not wording its mid-conversation-system recovery recognises.
 *
 * Re-labelling it as `user` keeps the instruction, keeps its position, and leaves the
 * prompt prefix untouched - which matters, because rewriting the front of the prompt
 * would cost the llama.cpp prompt cache on every turn. A system message that really
 * is first is left alone; templates handle that case fine.
 */
function normaliseRole(role: string, index: number): Role {
  if (role === "user" || role === "assistant") return role;
  if (role === "system" && index === 0) return "system";
  return "user";
}

function sanitizeMessage(msg: Message, index: number): Message {
  const role = normaliseRole(String(msg.role), index);
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }
  const content = msg.content
    .map(sanitizeBlock)
    .filter((b): b is ContentBlock => b !== null);
  return { role, content };
}

/**
 * How many messages had their role rewritten. Used by the contract tests to assert the
 * mid-conversation `system` message is actually being caught, rather than the test
 * passing because a fixture stopped containing one.
 */
export function countRewrittenRoles(messages: Message[] | undefined): number {
  if (!messages) return 0;
  let n = 0;
  for (const [i, m] of messages.entries()) {
    if (normaliseRole(String(m.role), i) !== m.role) n++;
  }
  return n;
}

function sanitizeSystem(
  system: string | ContentBlock[] | undefined,
): string | ContentBlock[] | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  // Order is preserved deliberately: a stable system-prompt prefix is what lets
  // llama.cpp reuse its prompt cache across turns. Reordering defeats it.
  return system
    .map(sanitizeBlock)
    .filter((b): b is ContentBlock => b !== null);
}

export function sanitizeTools(tools: ToolDef[] | undefined): ToolDef[] | undefined {
  if (!tools) return undefined;
  const out: ToolDef[] = [];
  for (const tool of tools) {
    // Server-side tool types (web_search, computer, text_editor, ...) have no local
    // implementation. Passing them through would advertise a tool that cannot run.
    if (tool.type && tool.type !== "custom") continue;
    if (!tool.name) continue;
    const clean: ToolDef = { name: tool.name };
    if (typeof tool.description === "string") clean.description = tool.description;
    if (tool.input_schema) clean.input_schema = tool.input_schema;
    out.push(clean);
  }
  return out;
}

export interface SanitizeOptions {
  /** llama-server --alias of the backend actually serving this request. */
  backendAlias: string;
  /** The loaded model's total context window, in tokens. */
  contextWindow?: number;
  /**
   * The model's `--reasoning-budget`, if it thinks. A request whose max_tokens does
   * not clear this cannot produce an answer - see the check in buildUpstreamRequest.
   */
  reasoningBudget?: number;
}

/** Never leave the model less room than this to answer in. */
const MIN_OUTPUT_TOKENS = 512;
/** Slack for chat-template scaffolding the byte estimate cannot see. */
const CONTEXT_SAFETY_TOKENS = 256;
/**
 * Bytes per token, deliberately pessimistic. Real English JSON runs nearer 4; using
 * 3 over-estimates the prompt, which errs toward leaving MORE room, not less.
 */
const BYTES_PER_TOKEN = 3;

function estimatePromptTokens(body: Record<string, unknown>): number {
  let bytes = 0;
  for (const key of ["system", "messages", "tools"]) {
    const v = body[key];
    if (v !== undefined) bytes += Buffer.byteLength(JSON.stringify(v), "utf8");
  }
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function buildUpstreamRequest(
  req: MessagesRequest,
  opts: SanitizeOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = { model: opts.backendAlias };

  for (const field of FORWARDED_FIELDS) {
    if (req[field] !== undefined) out[field] = req[field];
  }

  out.messages = (req.messages ?? []).map((m, i) => sanitizeMessage(m, i));

  const system = sanitizeSystem(req.system);
  if (system !== undefined) out.system = system;

  const tools = sanitizeTools(req.tools);
  if (tools && tools.length > 0) out.tools = tools;
  else delete out.tool_choice; // tool_choice without tools is a 400

  // max_tokens is required by the Messages API.
  //
  // Claude Code asks for a large output budget - 32000 was measured - sized for a
  // frontier model's window. On a local model the PROMPT AND THE OUTPUT SHARE ONE
  // 16K-32K context, so forwarding that verbatim overflows before a token is
  // generated. Capping at the full context window is equally wrong for the same
  // reason. What is actually available is whatever the prompt did not already use.
  const requested = typeof req.max_tokens === "number" ? req.max_tokens : 4096;

  if (opts.contextWindow && opts.contextWindow > 0) {
    const promptTokens = estimatePromptTokens(out);
    const available = opts.contextWindow - promptTokens - CONTEXT_SAFETY_TOKENS;

    if (available < MIN_OUTPUT_TOKENS) {
      // The prompt genuinely does not fit. Use the upstream's own wording: Claude
      // Code matches on it to trigger compaction and retry, and a gateway that
      // rephrases the error breaks that recovery path.
      throw GatewayError.invalidRequest(
        "prompt is too long: " + promptTokens + " tokens > " +
          (opts.contextWindow - MIN_OUTPUT_TOKENS) + " maximum",
      );
    }
    // No floor needed: `available < MIN_OUTPUT_TOKENS` already threw above, so
    // `available` is at least MIN_OUTPUT_TOKENS and the min() cannot go below it.
    out.max_tokens = Math.min(requested, available);
  } else {
    out.max_tokens = requested;
  }

  // Refuse a request that cannot produce an answer, rather than serving an empty one.
  //
  // A reasoning model writes its chain of thought into the SAME output allowance as
  // the reply, and the budget is a spawn argument, so it does not shrink to fit a
  // small max_tokens. Measured on the 9B at its default 4096-token budget with
  // max_tokens 500: stop_reason `max_tokens`, 500 output tokens, and a single
  // `thinking` block with no text at all. To the caller that is a model that answered
  // nothing, with nothing saying why.
  //
  // The threshold is the budget itself rather than budget+slack: at exactly the budget
  // there is room for zero answer tokens, and below it the thinking cannot even finish.
  const budget = opts.reasoningBudget ?? 0;
  const effective = typeof out.max_tokens === "number" ? out.max_tokens : requested;
  if (budget > 0 && effective <= budget) {
    throw GatewayError.invalidRequest(
      "max_tokens (" + effective + ") leaves no room to answer: this model thinks " +
        "before it replies and its reasoning budget is " + budget + " tokens, taken " +
        "from the same allowance. Raise max_tokens above " + budget + ", or lower the " +
        "budget with POST /admin/reasoning?budget=N (0 turns thinking off).",
    );
  }

  return out;
}

