/**
 * POST /v1/messages/count_tokens
 *
 * Optional per the gateway protocol reference - when it is absent Claude Code falls
 * back to counting context usage through the inference endpoint, which on a local
 * model means burning a full prefill just to learn a number. Implementing it is
 * cheap and keeps that waste off an already-tight GPU.
 *
 * llama-server exposes the same endpoint, so this forwards when a backend is up. If
 * nothing is loaded we estimate rather than provoke a model load: a token count must
 * never be the thing that triggers a 90-second swap.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "./messages.ts";
import { buildUpstreamRequest } from "../sanitize.ts";
import { log } from "../log.ts";
import type { CountTokensRequest, MessagesRequest } from "../types.ts";
import type { RequestContext } from "../context.ts";

export async function handleCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody<CountTokensRequest>(req);
  const { model } = ctx.registry.resolve(body.model);

  if (ctx.supervisor.isReadyFor(model.id)) {
    const forwarded = await forwardCount(body, model.alias, ctx);
    if (forwarded !== null) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: forwarded }));
      return;
    }
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
}

async function forwardCount(
  body: CountTokensRequest,
  alias: string,
  ctx: RequestContext,
): Promise<number | null> {
  try {
    const upstreamBody = buildUpstreamRequest(body as MessagesRequest, {
      backendAlias: alias,
    });
    delete upstreamBody.max_tokens;
    delete upstreamBody.stream;

    const upstream = await fetch(
      ctx.supervisor.backendUrl + "/v1/messages/count_tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + ctx.config.backendApiKey,
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!upstream.ok) return null;
    const parsed = (await upstream.json()) as { input_tokens?: number };
    return typeof parsed.input_tokens === "number" ? parsed.input_tokens : null;
  } catch (err) {
    log.debug("count_tokens forward failed; estimating", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Deliberately rough fallback: ~4 bytes per token over the serialised request. It
 * only has to be good enough for Claude Code's context-usage bar, and being wrong is
 * strictly better than triggering a model load to be right.
 */
function estimateTokens(body: CountTokensRequest): number {
  let bytes = 0;
  if (body.system) bytes += Buffer.byteLength(JSON.stringify(body.system), "utf8");
  if (body.messages) bytes += Buffer.byteLength(JSON.stringify(body.messages), "utf8");
  if (body.tools) bytes += Buffer.byteLength(JSON.stringify(body.tools), "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}
