/**
 * HTTP surface.
 *
 * Routing note that matters: Claude Code posts inference to `/v1/messages?beta=true`,
 * so every route match is on the PATH ONLY. Matching the full URL silently misses
 * every real request.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, type Config } from "./config.ts";
import { log, setLogLevel } from "./log.ts";
import { probeResources } from "./resources.ts";
import { Registry } from "./registry.ts";
import { Supervisor } from "./supervisor.ts";
import { RequestContext } from "./context.ts";
import { GatewayError, toEnvelope } from "./anthropic/errors.ts";
import { handleMessages } from "./anthropic/messages.ts";
import { handleCountTokens } from "./anthropic/count_tokens.ts";
import { handleModels } from "./anthropic/models.ts";
import { handleClientEnv } from "./anthropic/client_env.ts";
import { availableProfiles } from "./tools/prune.ts";

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const p = q === -1 ? raw : raw.slice(0, q);
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  const { status, body } = toEnvelope(err);
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  sendJson(res, status, body);
}

/**
 * Credential check. Off by default: the gateway is meant to be reached over
 * loopback, and requiring a token there is friction with no attacker excluded. Set
 * REQUIRE_AUTH=1 when exposing the port beyond the host.
 */
function checkAuth(req: IncomingMessage, cfg: Config): void {
  if (!cfg.requireAuth) return;
  const auth = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  const bearer = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (bearer === "" && key === "") {
    throw GatewayError.unauthorized(
      "missing credential: set ANTHROPIC_AUTH_TOKEN (sent as Authorization: Bearer) " +
        "or ANTHROPIC_API_KEY (sent as x-api-key)",
    );
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? "GET";

  // Connection-warming probe. Answering it costs nothing and keeps the client's
  // first real request off a cold socket.
  if (path === "/api/hello") {
    res.writeHead(200, { "content-length": "0" });
    res.end();
    return;
  }

  if (path === "/health" && method === "GET") {
    const status = ctx.supervisor.status();
    sendJson(res, 200, {
      status: status.state === "ready" ? "ok" : status.state,
      backend: status,
      recent: ctx.supervisor.recentLogs().slice(-12),
    });
    return;
  }

  if (path === "/v1/models" && method === "GET") {
    checkAuth(req, ctx.config);
    handleModels(res, ctx.registry);
    return;
  }

  if (path === "/v1/messages" && method === "POST") {
    checkAuth(req, ctx.config);
    await handleMessages(req, res, ctx);
    return;
  }

  if (path === "/v1/messages/count_tokens" && method === "POST") {
    checkAuth(req, ctx.config);
    await handleCountTokens(req, res, ctx);
    return;
  }

  if (path === "/admin/models" && method === "GET") {
    sendJson(res, 200, {
      default: ctx.registry.getDefaultId(),
      loaded: ctx.supervisor.currentModelId(),
      tool_profiles: availableProfiles(),
      models: ctx.registry.list().map((m) => ({
        id: m.id,
        display_name: m.display_name ?? m.id,
        tier: m.tier,
        size_gb: m.size_gb,
        context: m.context,
        capabilities: m.capabilities,
        available: m.available,
        unavailable_reason: m.unavailableReason ?? null,
        // Surfaced prominently: a model without tool support will not sustain
        // Claude Code's agent loop, whatever else it scores well on.
        drives_claude_code: m.capabilities.includes("tools"),
      })),
    });
    return;
  }

  if (path === "/admin/client-env" && method === "GET") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    handleClientEnv(
      res,
      ctx.registry,
      ctx.config,
      params.get("model"),
      params.get("format"),
    );
    return;
  }

  if (path === "/admin/preload" && method === "POST") {
    const requested = new URL(req.url ?? "/", "http://localhost").searchParams.get("model");
    const { model } = ctx.registry.resolve(requested ?? undefined);
    await ctx.supervisor.ensure(model);
    sendJson(res, 200, { loaded: model.id });
    return;
  }

  if (path === "/admin/metrics" && method === "GET") {
    sendJson(res, 200, {
      backend: ctx.supervisor.status(),
      config: {
        background_strategy: ctx.config.backgroundStrategy,
        tool_profile: ctx.config.toolProfile,
        idle_ttl_seconds: ctx.config.idleTtlSeconds,
        keepalive_ms: ctx.config.keepaliveMs,
      },
    });
    return;
  }

  throw GatewayError.notFound("no route for " + method + " " + path);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const resources = await probeResources(cfg.serverBin);
  log.info("host resources", {
    vramTotalMb: resources.vramTotalMb ?? "none",
    ramTotalMb: resources.ramTotalMb,
  });
  if (resources.vramTotalMb === null) {
    log.warn("no GPU detected; models will run on CPU and will be slow");
  }

  const registry = await Registry.load(cfg.registryPath, resources);
  const unavailable = registry.list().filter((m) => !m.available);
  log.info("registry loaded", {
    models: registry.list().length,
    unavailable: unavailable.length,
    default: registry.getDefaultId() ?? "none",
  });
  for (const m of unavailable) {
    log.warn("model unavailable on this host", {
      model: m.id,
      reason: m.unavailableReason ?? "unknown",
    });
  }

  const supervisor = new Supervisor(cfg);
  const ctx = new RequestContext(cfg, registry, supervisor);

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      log.debug("request", {
        method: req.method ?? "?",
        path: pathOf(req),
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    route(req, res, ctx).catch((err: unknown) => {
      const isExpected = err instanceof GatewayError && err.status < 500;
      if (!isExpected) {
        log.error("unhandled request error", {
          path: pathOf(req),
          err: err instanceof Error ? err.message : String(err),
        });
      }
      sendError(res, err);
    });
  });

  // Claude Code holds long-lived streams; the Node default would cut them short.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 120_000;

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    server.close();
    void supervisor.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // A port clash is the most likely first-run failure. An unhandled 'error' event
  // would surface it as a raw Node stack trace, which tells the user nothing.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error("port " + cfg.port + " is already in use", {
        hint: "another gateway may still be running; stop it or set PORT=<other>",
      });
    } else {
      log.error("server error", { err: err.message });
    }
    process.exit(1);
  });

  server.listen(cfg.port, cfg.host, () => {
    log.info("gateway listening", {
      url: "http://localhost:" + cfg.port,
      hint: "ANTHROPIC_BASE_URL=http://localhost:" + cfg.port,
    });
  });
}

main().catch((err: unknown) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
