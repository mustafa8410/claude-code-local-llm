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
import { Registry, reasoningRange } from "./registry.ts";
import { loadCustomModels, saveCustomModels, verifyHuggingFaceRepo } from "./custom-models.ts";
import { Supervisor } from "./supervisor.ts";
import { RequestContext, ensureCaptureDir } from "./context.ts";
import { GatewayError, toEnvelope } from "./anthropic/errors.ts";
import { handleMessages, readJsonBody } from "./anthropic/messages.ts";
import { handleCountTokens } from "./anthropic/count_tokens.ts";
import { handleModels } from "./anthropic/models.ts";
import { handleClientEnv } from "./anthropic/client_env.ts";
import { availableProfiles, isKnownProfile, describeProfiles } from "./tools/prune.ts";
import type { ModelEntry } from "./types.ts";

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

  if (path === "/admin/models" && method === "POST") {
    const entry = await readJsonBody<ModelEntry>(req);

    // Check the repo exists before accepting it. Skippable with ?verify=0 for an
    // air-gapped host, where the lookup can only ever fail.
    const verify = new URL(req.url ?? "/", "http://localhost").searchParams.get("verify");
    if (entry?.hf && verify !== "0") {
      const check = await verifyHuggingFaceRepo(entry.hf);
      if (!check.ok) throw GatewayError.invalidRequest(check.reason ?? "unknown repo");
      if (check.reason) log.warn("model added without verification", { reason: check.reason });
    }

    const added = ctx.registry.add(entry, ctx.resources);
    await saveCustomModels(ctx.registry, ctx.config);
    log.info("model added at runtime", {
      model: added.id,
      available: added.available,
      reason: added.unavailableReason ?? "fits",
    });
    sendJson(res, 201, {
      id: added.id,
      available: added.available,
      unavailable_reason: added.unavailableReason ?? null,
      reasoning_budget: added.reasoningBudget,
      // Weights are fetched on first use, so adding costs nothing until then - but only
      // an `hf` entry has anything to fetch. Telling someone who supplied a `path` to
      // pull it would send them after a download that does not exist.
      weights: added.hf
        ? "not downloaded yet - POST /admin/models/pull?model=" + added.id
        : "expected at " + added.path + " inside the container; mount it there",
    });
    return;
  }

  if (path === "/admin/models" && method === "DELETE") {
    const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("model");
    if (!id) throw GatewayError.invalidRequest("pass ?model=<id>");
    ctx.registry.remove(id);
    await saveCustomModels(ctx.registry, ctx.config);
    log.info("model removed", { model: id, note: "weights are left in the cache" });
    sendJson(res, 200, { removed: id, weights: "left in the model cache" });
    return;
  }

  if (path === "/admin/models/pull" && method === "POST") {
    const requested = new URL(req.url ?? "/", "http://localhost").searchParams.get("model");
    const { model } = ctx.registry.resolve(requested ?? undefined);

    // Downloading several GB takes far longer than any sensible client timeout, so the
    // response streams progress as it goes rather than going silent and hoping.
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    res.write("pulling " + model.id + "\n");

    const started = Date.now();
    try {
      // A pull is a load that is immediately released: llama-server has no
      // download-only mode, and loading is the only thing that proves the weights are
      // actually usable rather than merely present.
      await ctx.supervisor.ensure(model, (msg) => {
        if (!res.writableEnded) res.write(msg + "\n");
      });
      const wasAlreadyLoaded = ctx.supervisor.currentModelId() === model.id;
      if (wasAlreadyLoaded) await ctx.supervisor.stop();
      res.write("ok: " + model.id + " ready in " + (Date.now() - started) + "ms\n");
      res.write("released; the weights stay in the cache for the next request\n");
    } catch (err) {
      res.write("failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
    res.end();
    return;
  }

  if (path === "/admin/reasoning" && method === "GET") {
    sendJson(res, 200, {
      note:
        "A reasoning model spends thinking tokens from the same window as the prompt " +
        "and the answer. -1 unrestricted, 0 off, N a token budget.",
      models: ctx.registry.list().map((m) => ({
        id: m.id,
        reasoning_budget: m.reasoningBudget,
        supports_thinking: m.capabilities.includes("thinking"),
        allowed: reasoningRange(m),
        context: m.context,
      })),
    });
    return;
  }

  if (path === "/admin/reasoning" && method === "POST") {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const requested = params.get("model");
    const raw = params.get("budget");
    if (raw === null) {
      throw GatewayError.invalidRequest(
        "pass ?budget=N (-1 unrestricted, 0 off, N a token budget), and optionally &model=<id>",
      );
    }
    const { model } = ctx.registry.resolve(requested ?? undefined);
    const updated = ctx.registry.setReasoningBudget(model.id, Number(raw));

    // The budget only reaches llama-server through spawn arguments, so a model that is
    // already running keeps its old value until it restarts. Evict it rather than
    // reload eagerly: the operator may be adjusting several, and the next request pays
    // one cold load instead of every edit paying one.
    let evicted = false;
    if (ctx.supervisor.currentModelId() === updated.id) {
      await ctx.supervisor.stop();
      evicted = true;
    }
    sendJson(res, 200, {
      model: updated.id,
      reasoning_budget: updated.reasoningBudget,
      allowed: reasoningRange(updated),
      applied: evicted ? "backend evicted; next request reloads with the new budget" : "on next load",
    });
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

  // Refuse rather than serve slowly, and the reason is harder than "slow".
  //
  // Measured in this container with no GPU: prompt processing runs at ~18 tok/s. A
  // realistic Claude Code request - system prompt plus fifteen tool schemas, ~6,600
  // tokens - therefore needs around 370 s just to PREFILL, before it emits a token.
  // Claude Code abandons a stream that has been silent for 300 s. The 9B was measured
  // being killed at 5 min 13 s without ever completing one request.
  //
  // So CPU is not a slower tier of the same product; past a certain prompt size it
  // cannot finish a request at all, and the overwhelmingly likely cause of landing here
  // is a missing --gpus all rather than a deliberate choice. Failing names the fix.
  if (resources.vramTotalMb === null && !cfg.allowCpu) {
    log.error("no GPU detected - refusing to start", {
      // Listed first because it is the likeliest cause and the least obvious one.
      // GPU access is fixed when a container is CREATED, so a container made without
      // it can never gain it - pressing Start again reproduces this error forever.
      // Docker Desktop's Run button does not pass --gpus all and offers no field for
      // it, so "pass --gpus all" is unactionable advice to anyone working in the UI.
      docker_desktop:
        "the Run button does NOT give a container GPU access, and it cannot be added " +
        "afterwards - restarting this container will fail the same way. Either use " +
        "`docker compose up -d`, or make the GPU the default for every container: " +
        'Settings > Docker Engine > add "default-runtime": "nvidia", Apply & restart. ' +
        "This image already sets NVIDIA_VISIBLE_DEVICES=all, so the runtime is the " +
        "only missing piece, and the Run button then works",
      docker_cli:
        "docker run --gpus all ... (or --runtime=nvidia; either is required at " +
        "CREATION time, neither can be added to an existing container)",
      linux: "install the NVIDIA Container Toolkit",
      driver: "check nvidia-smi on the host; the CUDA image must match its driver",
      laptop: "a discrete GPU switched off for power saving reports no devices",
      override:
        "set ALLOW_CPU=1 to run on CPU anyway - but read the warning it prints; " +
        "Claude Code is unlikely to be usable",
    });
    process.exit(1);
  }
  if (resources.vramTotalMb === null) {
    // Deliberately blunt. The old wording said "single-digit tokens/sec", which reads
    // as an inconvenience and let a user pick the default 9B and hit a dead end with
    // nothing explaining it.
    log.warn("no GPU detected and ALLOW_CPU=1 is set; continuing on CPU", {
      prefill: "~18 tok/s measured, so a ~6,600-token Claude Code prompt needs ~370 s",
      deadline:
        "Claude Code aborts a stream silent for 300 s, so requests with a large tool " +
        "set will be abandoned before the first token - the 9B never completed one",
      advice:
        "use the smallest model in the catalog, keep the tool set small, and expect " +
        "this to be useful for trying the gateway out rather than for real sessions",
    });
  }

  // Validate TOOL_PROFILE here, not on the first request.
  //
  // An unrecognised value used to be a silent no-op: pruning simply did not happen, and
  // nothing said so. The consequence arrives much later and points somewhere else - on
  // a window too small for the full tool set, Claude Code reports `prompt is too long`,
  // which reads as a model problem rather than a typo in an environment variable.
  //
  // Falling back rather than exiting: a typo should not stop a container that can still
  // serve, and `full` is the same behaviour the unrecognised value already had - only
  // now it is announced.
  if (cfg.toolProfile !== null && !isKnownProfile(cfg.toolProfile)) {
    log.warn("TOOL_PROFILE is not recognised; continuing WITHOUT pruning", {
      got: cfg.toolProfile,
      using: "full (no pruning)",
      named: Object.entries(describeProfiles())
        .map(([k, v]) => `${k}=[${v.join(" ")}]`)
        .join("  "),
      lists: 'any tool list also works, e.g. TOOL_PROFILE="Read,Edit,Grep,Glob,Bash" - ' +
        "the same set `claude --tools` takes. A single bare word is read as a profile " +
        'name, so write "Read," for a one-tool list',
    });
    cfg.toolProfile = null;
  }

  const registry = await Registry.load(cfg.registryPath, resources, cfg.reasoningBudget);
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

  if (cfg.captureDir) {
    await ensureCaptureDir(cfg.captureDir);
    log.info("capturing request bodies", {
      dir: cfg.captureDir,
      warning: "captures include the system prompt and a client device id; scrub before sharing",
    });
  }

  // Models the user added through the API in a previous run. Never fatal: this is user
  // data that can go stale in ways the baked catalog cannot.
  await loadCustomModels(registry, cfg, resources);

  const supervisor = new Supervisor(cfg);
  const ctx = new RequestContext(cfg, registry, supervisor, resources);

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
