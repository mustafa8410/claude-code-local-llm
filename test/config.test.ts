/**
 * Configuration contract tests, focused on the auth knobs.
 *
 * REQUIRE_AUTH is the setting a user reaches for when they publish the port, so the
 * failure mode that matters is it appearing to work while accepting anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, OPTIONS, REPO } from "../src/config.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

test("every environment variable the code reads is documented in OPTIONS", () => {
  // /admin/config is the only documentation someone who pulled the image has - a
  // `docker run` never shows them a README. That makes drift between the parsing and
  // the published list a real failure rather than untidiness, so this reads the source
  // and holds the two together. Before OPTIONS existed the gateway read 24 variables
  // and published 4 of them.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "src", "config.ts"), "utf8");

  const read = new Set<string>();
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) read.add(m[1]!);
  for (const m of src.matchAll(/env(?:Int|Bool|Float|Enum)\("([A-Z][A-Z0-9_]{2,})"/g)) {
    read.add(m[1]!);
  }
  assert.ok(read.size > 15, `expected to find the env reads, found ${read.size}`);

  const documented = new Set(OPTIONS.map((o) => o.name));
  const missing = [...read].filter((n) => !documented.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `read by config.ts but absent from OPTIONS, so /admin/config hides them: ${missing.join(", ")}`,
  );

  for (const o of OPTIONS) {
    assert.ok(o.doc.length > 10, `${o.name} needs a real description`);
    assert.ok(o.def.length > 0, `${o.name} needs a stated default`);
  }
});

test("the documentation URL the container prints matches the image's own label", () => {
  // The banner, /admin/config and the OCI labels all tell someone where the docs are.
  // If they disagree, at least one of them is sending people nowhere - and the person
  // most likely to follow the link is the one who pulled the image and has no repo.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dockerfile = readFileSync(path.join(here, "..", "Dockerfile"), "utf8");

  assert.match(REPO, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, "REPO must be a plain repo URL");
  assert.ok(
    dockerfile.includes('org.opencontainers.image.source="' + REPO + '"'),
    `Dockerfile's image.source label does not match REPO (${REPO})`,
  );
});
