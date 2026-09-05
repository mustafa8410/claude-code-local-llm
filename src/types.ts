/**
 * Anthropic Messages API surface, narrowed to what Claude Code actually sends.
 *
 * Deliberately permissive: Claude Code gains capabilities over releases and they
 * arrive as NEW request body fields. Per the gateway protocol reference, a gateway
 * pinned to an observed list breaks on the release that introduces the next field.
 * So inbound types carry an index signature and nothing is rejected for being unknown.
 */

/**
 * "system" is included because Claude Code demonstrably sends a system-role message
 * inside messages[], despite the Messages API modelling system as a top-level field.
 * See normaliseRole in sanitize.ts for what happens to one that is not first.
 */
export type Role = "user" | "assistant" | "system";

export interface TextBlock {
  type: "text";
  text: string;
  [k: string]: unknown;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  [k: string]: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

/** Anything we do not model explicitly still round-trips as an opaque block. */
export interface UnknownBlock {
  type: string;
  [k: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | UnknownBlock;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
  [k: string]: unknown;
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  /** Beta field paired with a beta header; llama.cpp does not understand it. */
  strict?: boolean;
  /** MCP tool-search beta field. */
  defer_loading?: boolean;
  type?: string;
  [k: string]: unknown;
}

/** Inbound request from Claude Code. Index signature is load-bearing - see above. */
export interface MessagesRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  system?: string | ContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: ToolDef[];
  tool_choice?: unknown;
  /** Sent as {"type":"adaptive"} for unrecognised ids. Parsed but ignored upstream. */
  thinking?: unknown;
  /** Context-editing beta. Hard 400 upstream if forwarded blind. */
  context_management?: unknown;
  /** Carries effort + structured-output + task budget. Also a hard 400 upstream. */
  output_config?: unknown;
  metadata?: unknown;
  [k: string]: unknown;
}

export interface CountTokensRequest {
  model: string;
  messages: Message[];
  system?: string | ContentBlock[];
  tools?: ToolDef[];
  [k: string]: unknown;
}

export type ModelTier = "vram" | "offload" | "stretch";
export type ModelCapability = "tools" | "thinking" | "vision";

export interface ModelEntry {
  /** MUST contain "claude" or "anthropic" or Claude Code silently drops it. */
  id: string;
  display_name?: string;
  /** Hugging Face repo spec for llama-server -hf, e.g. "unsloth/Qwen3.5-9B-GGUF:Q4_K_M". */
  hf?: string;
  /** Absolute path to a local .gguf, as an alternative to `hf`. */
  path?: string;
  size_gb: number;
  context: number;
  capabilities: ModelCapability[];
  tier: ModelTier;
  default?: boolean;
  /**
   * Tokens this model may spend thinking before it must start answering.
   * `-1` unrestricted, `0` off, `N` a budget. Omit to take the derived default -
   * see defaultReasoningBudget in registry.ts.
   */
  reasoning_budget?: number;
  /** Extra llama-server argv appended after the generated base flags. */
  args?: string[];
}

export interface HostResources {
  vramTotalMb: number | null;
  vramFreeMb: number | null;
  ramTotalMb: number;
  ramFreeMb: number;
}
