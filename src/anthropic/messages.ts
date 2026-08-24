/**
 * POST /v1/messages - inference, and the one endpoint whose failure modes matter.
 *
 * The hard constraint this file is built around:
 *
 *   Claude Code counts every byte a gateway relays, including SSE `ping` events and
 *   COMMENT LINES, and aborts a stream that goes silent for 300 seconds.
 *
 * A model swap costs 10-90s (longer on a cold download) during which there is no
 * upstream to relay from. So when a request arrives that needs a different model, we
 * commit the 200 + text/event-stream headers FIRST and emit SSE comment lines while
 * the swap runs. Comment lines are ignored by every SSE parser but still count as
 * bytes, which is exactly the property needed.
 *
 * The cost of committing headers early is that the status code is then fixed: a swap
 * that fails afterwards cannot become a 503. That case is delivered as an in-stream
 * `event: error` instead, which Claude Code understands.
 *
 * Once llama-server is serving, its own --sse-ping-interval (30s default) keeps the
 * connection alive during long prefill, so we relay its bytes untouched.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { GatewayError, sseErrorEvent, toEnvelope } from "./errors.ts";
import { buildUpstreamRequest } from "../sanitize.ts";
import { pruneTools } from "../tools/prune.ts";
import { log } from "../log.ts";
import type { MessagesRequest } from "../types.ts";
import type { RequestContext } from "../context.ts";
import type { ResolvedModel } from "../registry.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new GatewayError("request_too_large", "request body exceeds 64MB");
    }
    chunks.push(buf);
  }
  if (total === 0) throw GatewayError.invalidRequest("empty request body");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (err) {
    throw GatewayError.invalidRequest("malformed JSON body: " + (err as Error).message);
  }
}

function openSseResponse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Defensive: any intermediary that buffers SSE stalls the client.
    "x-accel-buffering": "no",
  });
  // Flush headers now so the client sees the stream open before any swap begins.
  res.flushHeaders?.();
}

/** SSE comment line: invisible to parsers, but bytes on the wire. */
function comment(res: ServerResponse, text: string): void {
  res.write(": " + text.replace(/\r?\n/g, " ") + "\n\n");
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const body = await readJsonBody<MessagesRequest>(req);

  if (!Array.isArray(body.messages)) {
    throw GatewayError.invalidRequest("`messages` must be an array");
  }

  const { model, fellBack } = ctx.registry.resolve(body.model);
  if (fellBack && body.model) {
    log.debug("unknown model id, using default", {
      requested: body.model,
      serving: model.id,
    });
  }

  const target = ctx.chooseTarget(model, fellBack);
  const wantsStream = body.stream === true;
  const needsSwap = !ctx.supervisor.isReadyFor(target.id);

  ctx.capture(body);
  ctx.supervisor.trackStart();
  try {
    if (wantsStream && needsSwap) {
      await streamWithSwap(res, ctx, target, body);
    } else {
      await ctx.supervisor.ensure(target);
      await forward(res, ctx, target, body, false);
    }
  } finally {
    ctx.supervisor.trackEnd();
  }
}

/**
 * Streaming request that must wait for a model load. Headers are committed up front
 * so keepalive bytes can flow while the backend starts.
 */
async function streamWithSwap(
  res: ServerResponse,
  ctx: RequestContext,
  target: ResolvedModel,
  body: MessagesRequest,
): Promise<void> {
  openSseResponse(res);
  comment(res, "gateway: preparing " + target.id);

  const keepalive = setInterval(() => {
    if (!res.writableEnded) comment(res, "keepalive");
  }, ctx.config.keepaliveMs);
  keepalive.unref();

  const started = Date.now();
  try {
    await ctx.supervisor.ensure(target, (msg) => {
      if (!res.writableEnded) comment(res, "gateway: " + msg);
    });
  } catch (err) {
    clearInterval(keepalive);
    // Headers are already committed; the only way to report this is in-stream.
    log.warn("model load failed mid-stream", {
      model: target.id,
      err: err instanceof Error ? err.message : String(err),
    });
    if (!res.writableEnded) {
      res.write(sseErrorEvent(err));
      res.end();
    }
    return;
  }
  clearInterval(keepalive);
  log.info("swap complete", { model: target.id, ms: Date.now() - started });

  await forward(res, ctx, target, body, true);
}

async function forward(
  res: ServerResponse,
  ctx: RequestContext,
  target: ResolvedModel,
  body: MessagesRequest,
  headersAlreadySent: boolean,
): Promise<void> {
  let prepared: MessagesRequest = body;
  if (ctx.config.toolProfile) {
    const pruned = pruneTools(body.tools, ctx.config.toolProfile);
    if (pruned) prepared = { ...body, tools: pruned };
  }

  const upstreamBody = buildUpstreamRequest(prepared, {
    backendAlias: target.alias,
    contextWindow: target.context,
  });

  // Propagate client cancellation upstream.
  //
  // Without this, pressing Esc in Claude Code closed the socket while llama-server
  // carried on generating to completion - the GPU stayed busy producing tokens with
  // nowhere to go, and the model stayed pinned in VRAM because the request never
  // finished and the idle timer never rearmed. 'close' fires on the response for both
  // a client disconnect and a normal end; `res.writableEnded` distinguishes them.
  const abort = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.once("close", onClose);

  let upstream: Response;
  try {
    upstream = await fetch(ctx.supervisor.backendUrl + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + ctx.config.backendApiKey,
      },
      body: JSON.stringify(upstreamBody),
      signal: abort.signal,
    });
  } catch (err) {
    res.removeListener("close", onClose);
    if (abort.signal.aborted) {
      log.debug("client disconnected before the backend responded");
      if (!res.writableEnded) res.end();
      return;
    }
    const wrapped = GatewayError.internal(
      "backend unreachable: " + (err instanceof Error ? err.message : String(err)),
    );
    if (headersAlreadySent) {
      if (!res.writableEnded) {
        res.write(sseErrorEvent(wrapped));
        res.end();
      }
      return;
    }
    throw wrapped;
  }

  if (!upstream.ok) {
    // Pass the upstream body through unmodified. Claude Code's automatic-retry logic
    // matches on error wording, so re-wrapping it breaks recovery.
    const text = await upstream.text();
    if (headersAlreadySent) {
      if (!res.writableEnded) {
        res.write("event: error\ndata: " + normaliseError(text) + "\n\n");
        res.end();
      }
      return;
    }
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(normaliseError(text));
    return;
  }

  if (!upstream.body) {
    throw GatewayError.internal("backend returned no body");
  }

  const isStream = (upstream.headers.get("content-type") ?? "").includes("event-stream");

  if (!headersAlreadySent) {
    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(isStream
        ? {
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          }
        : {}),
    });
    res.flushHeaders?.();
  }

  // Relay byte-for-byte with no buffering. Buffering a complete response before
  // relaying it stalls Claude Code, which consumes events as they arrive.
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || abort.signal.aborted) break;
      if (!res.write(Buffer.from(value))) {
        // Wait for the socket to drain, but never unconditionally: on a destroyed
        // socket 'drain' never fires, and awaiting it forever stranded the handler.
        // trackEnd() would never run, inflight would stay above zero, and the idle
        // timer would never rearm - pinning the model in VRAM for the life of the
        // process. Aborting the signal rejects this wait.
        await once(res, "drain", { signal: abort.signal });
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      log.debug("client disconnected mid-stream; upstream generation aborted");
    } else {
      log.warn("relay interrupted", {
        err: err instanceof Error ? err.message : String(err),
      });
      if (isStream && !res.writableEnded) res.write(sseErrorEvent(err));
    }
  } finally {
    res.removeListener("close", onClose);
    reader.cancel().catch(() => undefined);
    if (!res.writableEnded) res.end();
  }
}

/** Keep an upstream error verbatim when it is already Anthropic-shaped. */
function normaliseError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { type?: string; error?: unknown };
    if (parsed && parsed.type === "error" && parsed.error) return text;
    return JSON.stringify(toEnvelope(GatewayError.internal(text.slice(0, 500))).body);
  } catch {
    return JSON.stringify(toEnvelope(GatewayError.internal(text.slice(0, 500))).body);
  }
}
