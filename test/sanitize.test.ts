/**
 * Contract tests for request shaping.
 *
 * The fixtures in test/fixtures/ are REAL request bodies captured from Claude Code
 * running against this gateway, not hand-written approximations. That matters: the
 * body Claude Code sends grows with each release, and every bug these tests cover
 * was found by looking at captured traffic rather than by reading the spec.
 *
 * THEY ARE SCRUBBED, AND ANY YOU ADD MUST BE TOO. A captured body carries
 * `metadata.user_id`, which contains a `device_id` - a stable fingerprint of the
 * machine that made the request - plus a session id and absolute paths containing the
 * operating-system username. None of that is a credential, and none of it belongs in a
 * public repository either. The committed copies have the device id zeroed, the session
 * id replaced with a nil UUID, and the username replaced with `dev`. Shape is preserved
 * exactly, because shape is the entire point of these files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildUpstreamRequest, countRewrittenRoles } from "../src/sanitize.ts";
import { GatewayError } from "../src/anthropic/errors.ts";
import type { MessagesRequest } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): MessagesRequest {
  return JSON.parse(
    readFileSync(path.join(here, "fixtures", name), "utf8"),
  ) as MessagesRequest;
}

test("drops Claude-Code-only fields that are hard 400s upstream", () => {
  const req: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    thinking: { type: "adaptive" },
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    output_config: { effort: "medium" },
    metadata: { user_id: "abc" },
  };
  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 8192 });

  for (const banned of ["thinking", "context_management", "output_config", "metadata"]) {
    assert.equal(out[banned], undefined, `${banned} must not reach llama-server`);
  }
  assert.equal(out.model, "m");
});

test("strips beta tool schema fields but keeps the tool", () => {
  const req: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "Read",
        description: "read a file",
        input_schema: { type: "object" },
        strict: true,
        defer_loading: true,
      },
    ],
  };
  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 8192 });
  const tools = out.tools as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "Read");
  assert.equal(tools[0]!.strict, undefined);
  assert.equal(tools[0]!.defer_loading, undefined);
});

test("drops server-side tool types that have no local implementation", () => {
  const req: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "web_search", type: "web_search_20250305" },
      { name: "Read", input_schema: { type: "object" } },
    ],
  };
  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 8192 });
  const names = (out.tools as { name: string }[]).map((t) => t.name);
  assert.deepEqual(names, ["Read"]);
});

test("max_tokens leaves room for the prompt instead of consuming the window", () => {
  // Regression: max_tokens was capped at the FULL context window, which overflows -
  // prompt and output share one window. Claude Code was measured asking for 32000.
  const req: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "x".repeat(3000) }],
    max_tokens: 32000,
  };
  const ctx = 16384;
  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: ctx });
  const maxTokens = out.max_tokens as number;

  assert.ok(maxTokens < ctx, "max_tokens must be smaller than the whole window");
  const promptEstimate = Math.ceil(JSON.stringify(out.messages).length / 3);
  assert.ok(
    maxTokens + promptEstimate <= ctx,
    `prompt (${promptEstimate}) + output (${maxTokens}) must fit in ${ctx}`,
  );
});

test("an over-long prompt fails with wording Claude Code can recover from", () => {
  const req: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "x".repeat(200_000) }],
    max_tokens: 4096,
  };
  assert.throws(
    () => buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 8192 }),
    (err: unknown) => {
      assert.ok(err instanceof GatewayError);
      // Claude Code matches on this wording to trigger compaction and retry.
      assert.match(err.message, /prompt is too long/i);
      return true;
    },
  );
});

test("mid-conversation system message is re-labelled, not forwarded as system", () => {
  // Real capture: Claude Code appends role:"system" as the LAST message. Qwen3.5's
  // Jinja template raises "System message must be at the beginning" and llama-server
  // 500s; Claude Code then retried the identical request 11 times.
  const req = fixture("claude-code-midconv-system.json");
  assert.equal(
    req.messages[req.messages.length - 1]!.role,
    "system",
    "fixture must actually contain the trailing system message",
  );

  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 16384 });
  const roles = (out.messages as { role: string }[]).map((m) => m.role);

  assert.ok(
    !roles.slice(1).includes("system"),
    `no system role may survive past index 0, got ${JSON.stringify(roles)}`,
  );
  assert.equal(countRewrittenRoles(req.messages), 1);
});

test("a leading system message is left alone", () => {
  const req: MessagesRequest = {
    model: "x",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  };
  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 8192 });
  const roles = (out.messages as { role: string }[]).map((m) => m.role);
  assert.deepEqual(roles, ["system", "user"]);
});

test("real captured Claude Code traffic survives sanitisation", () => {
  for (const name of ["claude-code-initial.json", "claude-code-midconv-system.json"]) {
    const req = fixture(name);
    const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 16384 });
    assert.ok(Array.isArray(out.messages), `${name}: messages preserved`);
    assert.equal(out.output_config, undefined, `${name}: output_config dropped`);
    assert.ok((out.max_tokens as number) > 0, `${name}: max_tokens set`);
  }
});

test("system array order is preserved so the prompt cache survives", () => {
  const req: MessagesRequest = {
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    system: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
  };
  const out = buildUpstreamRequest(req, { backendAlias: "m", contextWindow: 8192 });
  const texts = (out.system as { text: string }[]).map((b) => b.text);
  assert.deepEqual(texts, ["first", "second"]);
});
