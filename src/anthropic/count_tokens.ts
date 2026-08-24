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
import type { ResolvedModel } from "../registry.ts";

export async function handleCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody<CountTokensRequest>(req);
  const { model, fellBack } = ctx.registry.resolve(body.model);
  const target = countTarget(ctx, model, fellBack);

  if (ctx.supervisor.isReadyFor(target.id)) {
    const forwarded = await forwardCount(body, target.alias, ctx);
    if (forwarded !== null) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: forwarded }));
      return;
    }
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
}

/**
 * Resolve the model that would actually answer, using the same policy as inference.
 *
 * Counting used to check readiness against whatever the id RESOLVED to, while
 * /v1/messages routes the same id through RequestContext.chooseTarget. Those disagree
 * in exactly the case BACKGROUND_STRATEGY=reuse-primary exists for: an unrecognised id
 * arriving while a non-default model is loaded resolves to the default, which is not
 * the model that is serving, so the readiness check always missed and every count fell
 * back to the estimate even though a usable backend was right there.
 *
 * A policy rejection (BACKGROUND_STRATEGY=reject) is not worth failing a token count
 * over - the estimate is a fine answer - so that degrades rather than throwing.
 */
function countTarget(
  ctx: RequestContext,
  model: ResolvedModel,
  fellBack: boolean,
): ResolvedModel {
  try {
    return ctx.chooseTarget(model, fellBack);
  } catch {
    return model;
  }
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
