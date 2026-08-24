/**
 * Configuration contract tests, focused on the auth knobs.
 *
 * REQUIRE_AUTH is the setting a user reaches for when they publish the port, so the
 * failure mode that matters is it appearing to work while accepting anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

/** Run `fn` with the given env applied, restoring whatever was there before. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAR = { REQUIRE_AUTH: undefined, GATEWAY_API_KEY: undefined };

test("REQUIRE_AUTH without a key is refused instead of silently accepting anything", () => {
  // Regression: this combination used to start happily and then admit any non-empty
  // token, so the one setting meant for exposing the port past localhost was theatre.
  withEnv({ ...CLEAR, REQUIRE_AUTH: "1" }, () => {
    assert.throws(() => loadConfig(), /GATEWAY_API_KEY/);
  });
});

test("setting a key is enough to enable enforcement", () => {
  withEnv({ ...CLEAR, GATEWAY_API_KEY: "s3cret" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.requireAuth, true, "configuring a secret states the intent");
    assert.equal(cfg.gatewayApiKey, "s3cret");
  });
});

test("REQUIRE_AUTH with a key enables enforcement", () => {
  withEnv({ ...CLEAR, REQUIRE_AUTH: "1", GATEWAY_API_KEY: "s3cret" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.requireAuth, true);
  });
});

test("auth is off by default, because the gateway is a loopback service", () => {
  withEnv(CLEAR, () => {
    const cfg = loadConfig();
    assert.equal(cfg.requireAuth, false);
    assert.equal(cfg.gatewayApiKey, null);
  });
});

test("a blank GATEWAY_API_KEY is treated as absent, not as an empty secret", () => {
  // Otherwise `GATEWAY_API_KEY=` in a compose file would enable auth against "".
  withEnv({ ...CLEAR, GATEWAY_API_KEY: "   " }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.gatewayApiKey, null);
    assert.equal(cfg.requireAuth, false);
  });
});

test("MEMORY_BUDGET_GB rejects nonsense rather than becoming NaN", () => {
  withEnv({ ...CLEAR, MEMORY_BUDGET_GB: "lots" }, () => {
    assert.throws(() => loadConfig(), /MEMORY_BUDGET_GB/);
  });
  withEnv({ ...CLEAR, MEMORY_BUDGET_GB: "-4" }, () => {
    assert.throws(() => loadConfig(), /MEMORY_BUDGET_GB/);
  });
  withEnv({ ...CLEAR, MEMORY_BUDGET_GB: "7.5" }, () => {
    assert.equal(loadConfig().memoryBudgetGb, 7.5);
  });
});
