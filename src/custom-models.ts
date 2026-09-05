/**
 * Models a user added at runtime, persisted beside the weights.
 *
 * The image ships a catalog chosen for one 8 GB laptop. Anyone else's hardware wants
 * different models, and editing a baked-in YAML means rebuilding the image or bind
 * mounting a file - neither of which a person trying the container for the first time
 * should have to do. `POST /admin/models` adds one; this is where it is remembered.
 *
 * The file lives in the model cache directory because that is already a volume the
 * gateway owns and that users already mount to keep several GB of weights. A model entry
 * without its weights would be a broken promise, so the two belong together.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { log } from "./log.ts";
import type { Registry } from "./registry.ts";
import type { Config } from "./config.ts";
import type { HostResources, ModelEntry } from "./types.ts";

const FILE = "custom-models.yaml";

export function customModelsPath(cfg: Config): string {
  return path.join(cfg.modelCacheDir, FILE);
}

/**
 * Merge previously added models into the registry.
 *
 * A bad entry here must never stop the gateway starting. This is user data written by a
 * past version of the API, and it can go stale in ways the baked catalog cannot - a
 * model that fitted before a RAM change, an id that a later validation rule rejects.
 * Startup logs the entry it skipped and carries on serving everything else.
 */
export async function loadCustomModels(
  registry: Registry,
  cfg: Config,
  res: HostResources,
): Promise<void> {
  const file = customModelsPath(cfg);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return; // No file is the normal case, not an error.
  }

  let entries: ModelEntry[] = [];
  try {
    entries = (parseYaml(raw) as { models?: ModelEntry[] } | null)?.models ?? [];
  } catch (err) {
    log.error("custom model file is not valid YAML; ignoring it", {
      file,
      err: (err as Error).message,
    });
    return;
  }

  let added = 0;
  for (const entry of entries) {
    try {
      registry.add(entry, res);
      added += 1;
    } catch (err) {
      log.error("skipping a stored custom model", {
        model: entry?.id ?? "(no id)",
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (added > 0) log.info("loaded custom models", { file, added });
}

/**
 * Check that an `hf` spec names a repo that actually exists, before accepting it.
 *
 * A typo is the likeliest mistake when adding a model by hand, and llama-server's
 * failure for a repo it cannot resolve is genuinely unreadable - it reports
 * `exactly one out metadata, path_model, and file must be defined` and
 * `failed to load model ''`, neither of which points at the name being wrong. Worse,
 * that error only arrives at pull time, long after the POST said 201.
 *
 * Deliberately advisory about the network: if Hugging Face cannot be reached at all we
 * allow the entry rather than making model management depend on internet reachability
 * at exactly the moment someone might be setting up offline.
 */
export async function verifyHuggingFaceRepo(
  hf: string,
): Promise<{ ok: boolean; reason?: string }> {
  const repo = hf.split(":")[0];
  if (!repo || !repo.includes("/")) {
    return { ok: false, reason: `"${hf}" is not org/repo[:QUANT]` };
  }
  try {
    const res = await fetch("https://huggingface.co/api/models/" + repo, {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true };
    // Hugging Face answers 401 for a repo that does not exist AND for one that is
    // gated or private, so the message has to cover both rather than assert a typo.
    return {
      ok: false,
      reason:
        `Hugging Face returned ${res.status} for "${repo}" - it does not exist, or it ` +
        `is gated or private and this container has no token for it`,
    };
  } catch {
    return { ok: true, reason: "could not reach Hugging Face; accepted unverified" };
  }
}

/** Rewrite the file from whatever the registry currently holds. */
export async function saveCustomModels(registry: Registry, cfg: Config): Promise<void> {
  const file = customModelsPath(cfg);
  const models = registry.customEntries();
  const body =
    "# Models added through POST /admin/models. Managed by the gateway - edit\n" +
    "# config/models.yaml for entries you want to keep under version control.\n" +
    stringifyYaml({ models });
  await writeFile(file, body, "utf8");
  log.debug("persisted custom models", { file, count: models.length });
}
