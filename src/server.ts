/**
 * HTTP surface.
 *
 * Routing note that matters: Claude Code posts inference to `/v1/messages?beta=true`,
 * so every route match is on the PATH ONLY. Matching the full URL silently misses
 * every real request.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
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

/** The credential the caller presented, by either accepted header. */
function presentedCredential(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (bearer !== "") return bearer;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey.trim() : "";
}

/**
 * Compare in constant time. Hashing first gives both sides a fixed 32 bytes, which
 * keeps timingSafeEqual from throwing on a length mismatch - and stops the length of
 * the real secret leaking through which comparisons throw and which do not.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Credential check. Off by default: the gateway is meant to be reached over loopback,
 * and requiring a token there is friction with no attacker excluded.
 *
 * When it IS on, it compares against GATEWAY_API_KEY. It previously only checked that
 * some non-empty token had been sent, which is not authentication - any caller who
 * could reach the port could satisfy it by sending the word "x". That mattered because
 * REQUIRE_AUTH is precisely the setting a user reaches for when publishing the port.
 * loadConfig now refuses to start with REQUIRE_AUTH=1 and no key, so `gatewayApiKey`
 * is non-null whenever `requireAuth` is true.
 */
function checkAuth(req: IncomingMessage, cfg: Config): void {
  if (!cfg.requireAuth) return;

  const token = presentedCredential(req);
  if (token === "") {
    throw GatewayError.unauthorized(
      "missing credential: set ANTHROPIC_AUTH_TOKEN (sent as Authorization: Bearer) " +
        "or ANTHROPIC_API_KEY (sent as x-api-key)",
    );
  }
  if (cfg.gatewayApiKey === null || !secretsMatch(token, cfg.gatewayApiKey)) {
    throw GatewayError.unauthorized("invalid credential");
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
    const models = ctx.registry.list();
    const available = models.filter((m) => m.available).length;

    // The status code has to mean something: Docker's HEALTHCHECK tests only that, so
    // answering 200 with "everything is unavailable" in the body reports a container
    // as healthy when it can serve nothing at all.
    //
    // `idle` stays healthy on purpose - it is the normal resting state after the
    // idle-TTL unload, and flapping on it would restart a container that is working.
    // The condition that genuinely means "cannot serve" is having no loadable model,
    // which is exactly the no-GPU and out-of-memory case.
    const serviceable = available > 0;
    sendJson(res, serviceable ? 200 : 503, {
      status: serviceable
        ? status.state === "ready"
          ? "ok"
          : status.state
        : "no_models_available",
      serviceable,
      models: { total: models.length, available },
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

  // Everything under /admin needs the same credential as /v1. It used to need none at
  // all, which mattered most for preload: an unauthenticated caller who could reach the
  // port could spawn a model and occupy the GPU. client-env also hands out the auth
  // token, so leaving it open would have published the key that guards everything else.
  if (path.startsWith("/admin/")) {
    checkAuth(req, ctx.config);
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

  const resources = await probeResources(cfg.serverBin, cfg.memoryBudgetGb);
  log.info("host resources", {
    vramTotalMb: resources.vramTotalMb ?? "none",
    ramTotalMb: resources.ramTotalMb,
    ramSource: cfg.memoryBudgetGb === null ? "detected" : "MEMORY_BUDGET_GB",
  });

  // Refuse rather than serve slowly. A 9B on CPU answers at roughly 2 tok/s, which a
  // user reads as a broken gateway, not a slow one - and the overwhelmingly likely
  // cause is a missing --gpus all rather than a deliberate choice to run on CPU.
  // Failing here names the fix; starting anyway hides it behind a bad experience.
  if (resources.vramTotalMb === null && !cfg.allowCpu) {
    log.error("no GPU detected - refusing to start", {
      docker: "pass --gpus all (and install the NVIDIA Container Toolkit on Linux)",
      driver: "check nvidia-smi on the host; the CUDA image must match its driver",
      laptop: "a discrete GPU switched off for power saving reports no devices",
      override: "set ALLOW_CPU=1 to run on CPU anyway, accepting single-digit tok/s",
    });
    process.exit(1);
  }
  if (resources.vramTotalMb === null) {
    log.warn("no GPU detected and ALLOW_CPU=1 is set; continuing on CPU", {
      expect: "single-digit tokens/sec; prefer the smallest model in the catalog",
    });
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

  // Never let the default change silently: the picker and every unrecognised id follow
  // it, so a user who reads the catalog and gets a different model deserves the reason.
  const marked = registry.getMarkedDefaultId();
  if (marked !== null && marked !== registry.getDefaultId()) {
    log.warn("catalog default cannot run here; using the largest model that fits", {
      catalogDefault: marked,
      using: registry.getDefaultId() ?? "none",
      reason: registry.get(marked)?.unavailableReason ?? "unknown",
    });
  }
  if (registry.list().every((m) => !m.available)) {
    log.error("no model in the catalog can run on this host", {
      hint: "raise the memory budget, add a smaller model, or check GPU passthrough",
      health: "/health will report 503 until at least one model fits",
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
