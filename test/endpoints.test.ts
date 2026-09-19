/**
 * The published endpoint list has to match the routing table.
 *
 * The help page is the only API documentation somebody who pulled the image has, and a
 * route listed without its parameters is barely documentation at all - `POST
 * /admin/models/pull` is useless until you know it wants `?model=`. So this reads
 * server.ts and fails when the two disagree, in either direction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ENDPOINTS } from "../src/endpoints.ts";

function routedPaths(): Set<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "src", "server.ts"), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/path === "([^"]+)"/g)) found.add(m[1]!);
  return found;
}

test("every route the server answers is documented with its parameters", () => {
  const routed = routedPaths();
  assert.ok(routed.size > 10, `expected to find the routes, found ${routed.size}`);

  const documented = new Set(ENDPOINTS.map((e) => e.path));
  const undocumented = [...routed].filter((p) => !documented.has(p)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `routed by server.ts but missing from ENDPOINTS, so /help hides them: ${undocumented.join(", ")}`,
  );

  // And nothing documented that does not exist - a parameter list for a route that was
  // removed sends people at a 404 with confidence.
  const phantom = [...documented].filter((p) => !routed.has(p)).sort();
  assert.deepEqual(
    phantom,
    [],
    `documented in ENDPOINTS but not routed: ${phantom.join(", ")}`,
  );
});

test("each entry says enough to call it", () => {
  for (const e of ENDPOINTS) {
    assert.ok(e.what.length > 15, `${e.path} needs a real description`);
    assert.match(e.method, /^(GET|POST|DELETE|PUT|ANY)$/, `${e.path} has an odd method`);
    // Query parameters are written `name` or `name - explanation`; the explanation is
    // what makes them useful, so require it wherever one is given.
    for (const q of e.query ?? []) {
      assert.match(q, /^[a-z_]+=?[^ ]* - .+/, `${e.path}: parameter "${q}" needs an explanation`);
    }
  }
});

test("the routes that must stay open are marked open", () => {
  // /health backs the container healthcheck and /help is how somebody locked out finds
  // out how to configure the credential. Marking either as requiring auth in the docs
  // would be wrong about the code and would send people in circles.
  for (const p of ["/health", "/", "/api/hello"]) {
    const e = ENDPOINTS.find((x) => x.path === p)!;
    assert.equal(e.auth, false, `${p} is open in server.ts and must be documented as open`);
  }
  // Conversely everything under /admin is gated, and saying otherwise would imply the
  // gateway is less protected than it is.
  for (const e of ENDPOINTS.filter((x) => x.path.startsWith("/admin/"))) {
    assert.equal(e.auth, true, `${e.path} sits behind checkAuth`);
  }
});
