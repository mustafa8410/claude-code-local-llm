/**
 * Anthropic-shaped error envelopes.
 *
 * Claude Code's automatic-retry logic matches on the upstream error WORDING, not
 * just the status code. A gateway that wraps errors in its own envelope breaks the
 * recovery path even when the status is preserved. So every failure leaving this
 * process must look like an Anthropic API error and nothing else.
 */

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

const STATUS_BY_TYPE: Record<AnthropicErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

export class GatewayError extends Error {
  readonly kind: AnthropicErrorType;
  readonly status: number;

  constructor(kind: AnthropicErrorType, message: string) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    this.status = STATUS_BY_TYPE[kind];
  }

  static invalidRequest(message: string): GatewayError {
    return new GatewayError("invalid_request_error", message);
  }
  static notFound(message: string): GatewayError {
    return new GatewayError("not_found_error", message);
  }
  static unauthorized(message: string): GatewayError {
    return new GatewayError("authentication_error", message);
  }
  static internal(message: string): GatewayError {
    return new GatewayError("api_error", message);
  }
  static overloaded(message: string): GatewayError {
    return new GatewayError("overloaded_error", message);
  }
}

export interface ErrorEnvelope {
  type: "error";
  error: { type: AnthropicErrorType; message: string };
}

/**
 * Separates the message from the status code the client prints in front of it.
 *
 * Just a dash. It could carry the project name too, but the problem being solved is
 * legibility, and a long tag in front of every error is its own kind of noise.
 */
const SOURCE = "-";

/**
 * Anthropic's own wording for a context overflow, which Claude Code parses.
 *
 * It must be left ALONE. Claude Code matches it three different ways, and one of them
 * is anchored:
 *
 *   t.includes("prompt is too long")                      -> a prefix is harmless
 *   r.startsWith("prompt is too long")                    -> a prefix BREAKS this
 *   /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/ -> reads the numbers out
 *
 * That second one drives its compaction path, so decorating this message would trade a
 * tidier error for a session that stops recovering from a full context.
 */
const VERBATIM = /^prompt is too long/i;

/**
 * Put a separator in front of the message, because the client will not.
 *
 * Claude Code renders a failure as `API Error: 400 <message>` with nothing in between,
 * so a message opening with a lowercase word runs straight into the number:
 *
 *   API Error: 400 model local-claude-qwen3.6-35b-a3b cannot run on this host: ...
 *
 * which reads as though "400 model" were a phrase, and buries where the status ends and
 * the explanation begins. One dash is enough to break it apart:
 *
 *   API Error: 400 - model local-claude-qwen3.6-35b-a3b cannot run on this host: ...
 */
function label(message: string): string {
  if (VERBATIM.test(message) || message.startsWith(SOURCE)) return message;
  return SOURCE + " " + message;
}

export function toEnvelope(err: unknown): { status: number; body: ErrorEnvelope } {
  if (err instanceof GatewayError) {
    return {
      status: err.status,
      body: { type: "error", error: { type: err.kind, message: label(err.message) } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { type: "error", error: { type: "api_error", message: label(message) } },
  };
}

/**
 * Error delivered INSIDE an already-open SSE stream.
 *
 * Once we have written 200 + text/event-stream headers - which we must do before a
 * model swap so that keepalives can flow - the status code is committed and an HTTP
 * error is no longer expressible. Anthropic's stream protocol has an `error` event
 * for exactly this case.
 */
export function sseErrorEvent(err: unknown): string {
  const { body } = toEnvelope(err);
  return `event: error\ndata: ${JSON.stringify(body)}\n\n`;
}
