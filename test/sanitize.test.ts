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

test("a max_tokens the thinking budget would swallow is widened, not refused", () => {
  // A reasoning model writes its chain of thought into the SAME allowance as the
  // reply, and the budget is a spawn argument that does not shrink to fit. Measured
  // on the 9B at its 4096 default with max_tokens 500: stop_reason `max_tokens`, 500
  // output tokens, one `thinking` block, no text.
  //
  // This first threw. A real session showed that to be the wrong call: Claude Code
  // sends small max_tokens itself - 558 was observed - so refusing broke live traffic
  // that was merely sized without knowledge of the budget. Widen instead.
  const req = {
    model: "m",
    max_tokens: 558,
    messages: [{ role: "user" as const, content: "hi" }],
  };

  const widened = buildUpstreamRequest(req, {
    backendAlias: "m", contextWindow: 65536, reasoningBudget: 4096,
  });
  assert.ok(
    (widened.max_tokens as number) > 4096,
    `must clear the budget, got ${widened.max_tokens}`,
  );

  // An ample request is left exactly as asked.
  const ok = buildUpstreamRequest(
    { ...req, max_tokens: 8000 },
    { backendAlias: "m", contextWindow: 65536, reasoningBudget: 4096 },
  );
  assert.equal(ok.max_tokens, 8000, "no meddling when there was already room");

  // A model that does not think has no budget to compete with; nothing is touched.
  const nonThinking = buildUpstreamRequest(req, {
    backendAlias: "m", contextWindow: 65536, reasoningBudget: 0,
  });
  assert.equal(nonThinking.max_tokens, 558);

  // And when there is NOT room to widen, the request still goes through. An earlier
  // version threw here; it rejected a bare "hey" on a 4B whose window the tool
  // schemas had already filled, which is worse than a short answer and is not
  // something the caller can act on - they did not pick max_tokens, and they cannot
  // see the budget. A prompt that genuinely does not fit is caught further up with
  // `prompt is too long`, which is the wording Claude Code's compaction keys on.
  const cramped = buildUpstreamRequest(req, {
    backendAlias: "m", contextWindow: 5000, reasoningBudget: 4096,
  });
  assert.ok(
    typeof cramped.max_tokens === "number" && cramped.max_tokens > 0,
    "a cramped window must still produce a request, not an error",
  );
});
