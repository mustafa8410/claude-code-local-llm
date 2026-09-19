/**
 * Every route, with what it accepts.
 *
 * The help page used to list routes and nothing else, which tells you an endpoint
 * exists and not how to call it - `POST /admin/models/pull` is useless without knowing
 * it wants `?model=`. Naming the parameters is most of the value.
 *
 * `test/endpoints.test.ts` reads server.ts and fails if a route is added without an
 * entry here, so the published surface cannot fall behind the routing table.
 */

export interface Endpoint {
  method: string;
  path: string;
  /** Query parameters, as `name` or `name=<what it takes>`. */
  query?: string[];
  /** Shape of the request body, for the routes that take one. */
  body?: string;
  what: string;
  /** Whether the credential is required when GATEWAY_API_KEY is set. */
  auth: boolean;
}

export const ENDPOINTS: readonly Endpoint[] = [
  {
    method: "GET", path: "/", auth: false,
    what: "this help page, generated from the configuration actually in force",
  },
  {
    method: "GET", path: "/help", auth: false,
    what: "the same page, for anyone who guesses at a name rather than the root",
  },
  {
    method: "GET", path: "/health", auth: false,
    what:
      "state, backend status and the last backend log lines. 503 when no model can run " +
      "here, so a container healthcheck means something",
  },
  {
    method: "POST", path: "/v1/messages", auth: true,
    query: ["beta - accepted and ignored, Claude Code sends it"],
    body: '{"model", "messages", "max_tokens", "stream", "tools", "system"}',
    what: "inference. Streaming or not; unknown fields are dropped rather than rejected",
  },
  {
    method: "POST", path: "/v1/messages/count_tokens", auth: true,
    body: '{"model", "messages", "tools", "system"}',
    what: "count tokens without loading a model - estimated, never forces a spawn",
  },
  {
    method: "GET", path: "/v1/models", auth: true,
    what:
      "discovery. Fills Claude Code's /model picker, which needs " +
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 on the client",
  },
  {
    method: "GET", path: "/admin/models", auth: true,
    what: "the catalog with capabilities, sizes, and why anything is unavailable here",
  },
  {
    method: "POST", path: "/admin/models", auth: true,
    query: ["verify=0 - skip the Hugging Face existence check, for an air-gapped host"],
    body:
      '{"id", "hf" or "path", "size_gb", "context", "capabilities": ["tools",...], ' +
      '"tier": "vram|offload|stretch", "display_name"?, "args"?}',
    what:
      "add a model at runtime. The id must contain `claude` and must not start with " +
      "`claude-`; persisted to the model volume so it survives a restart",
  },
  {
    method: "DELETE", path: "/admin/models", auth: true,
    query: ["model=<id> - required"],
    what: "forget a model added at runtime. Catalog entries cannot be deleted; weights stay cached",
  },
  {
    method: "POST", path: "/admin/models/pull", auth: true,
    query: ["model=<id> - required"],
    what:
      "download the weights now rather than on first use. Streams progress as plain " +
      "text, loads the model to prove they work, then releases it",
  },
  {
    method: "POST", path: "/admin/preload", auth: true,
    query: ["model=<id> - defaults to the default model"],
    what: "load a model into VRAM without issuing a request",
  },
  {
    method: "GET", path: "/admin/client-env", auth: true,
    query: [
      "format=sh|ps1 - shell commands; omit for JSON",
      "model=<id> - configure for a model other than the default",
    ],
    what: "the exact Claude Code configuration for a model, from the live registry",
  },
  {
    method: "GET", path: "/admin/reasoning", auth: true,
    what: "thinking budget per model, with the range this gateway will accept",
  },
  {
    method: "POST", path: "/admin/reasoning", auth: true,
    query: [
      "budget=N - required. -1 unrestricted, 0 off, N a token budget",
      "model=<id> - defaults to the default model",
    ],
    what:
      "change a thinking budget live. It reaches llama-server as a spawn argument, so a " +
      "loaded model is evicted and the next request reloads with the new value",
  },
  {
    method: "GET", path: "/admin/config", auth: true,
    what: "every setting and worked example, as JSON. The machine-readable half of this page",
  },
  {
    method: "GET", path: "/admin/metrics", auth: true,
    what: "spawn and swap counts, inflight requests, and the config that affects them",
  },
  {
    method: "ANY", path: "/api/hello", auth: false,
    what: "connection-warming probe Claude Code sends before its first real request",
  },
];
