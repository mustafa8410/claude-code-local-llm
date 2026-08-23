/**
 * GET /v1/models - model discovery for Claude Code's /model picker.
 *
 * Three constraints from the gateway protocol reference shape this handler, and all
 * three fail SILENTLY when violated:
 *
 *   1. Claude Code keeps an entry only if its `id` contains "claude" or "anthropic".
 *      The registry rejects non-conforming ids at startup so this cannot happen.
 *   2. The request carries a 3-SECOND timeout. Nothing here may touch the GPU, spawn
 *      a process, or hit the network - it answers from memory only.
 *   3. Any redirect is treated as failure, so the credential cannot leak to a
 *      redirect target. Serve at the configured path directly; never 301 to a slash.
 *
 * Discovery is also opt-in on the client: CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1.
 */

import type { ServerResponse } from "node:http";
import type { Registry } from "../registry.ts";

interface ModelListEntry {
  type: "model";
  id: string;
  display_name?: string;
  created_at?: string;
}

export function handleModels(res: ServerResponse, registry: Registry): void {
  const data: ModelListEntry[] = [];

  for (const model of registry.list()) {
    // An unavailable model is still listed: seeing it greyed-out-but-present with a
    // reason is far more useful than it silently missing from the picker.
    const suffix = model.available ? "" : " (unavailable)";
    const entry: ModelListEntry = { type: "model", id: model.id };
    const label = model.display_name ?? model.id;
    entry.display_name = label + suffix;
    data.push(entry);
  }

  const body = JSON.stringify({ data, has_more: false, first_id: null, last_id: null });
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(body);
}
