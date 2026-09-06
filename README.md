# claude-code-local-llm

Run any local GGUF model behind Claude Code.

An Anthropic-compatible gateway that sits in front of `llama.cpp`, hot-swaps models
on demand, and absorbs the handful of Claude-Code-specific behaviours that otherwise
make a local model unusable as a backend.

```
Claude Code  ──►  gateway :8787  ──►  llama-server :8080  ──►  your GGUF
```

## Quickstart

```bash
# 1. start the gateway (Docker image: see "Container" below)
./run-gateway.sh

# 2. point Claude Code at it - the gateway emits the exact config for the model
eval "$(curl -s 'http://localhost:8787/admin/client-env?format=sh' | grep ^export)"

# 3. use it
claude --tools "Read,Edit,Grep,Glob,Bash"
```

PowerShell: `curl -s 'http://localhost:8787/admin/client-env?format=ps1' | iex`

The first request downloads the model (~5.6 GB for the default) into a volume and
streams keepalives while it happens, so the session does not time out.

## Why this exists

`llama-server` already speaks the Anthropic Messages API, and `llama-swap` already
swaps models. What neither does is survive contact with Claude Code specifically.
Every item below was found by running the real client against a real local model and
reading the captured traffic.

### Model ids must thread a needle

Two Claude Code behaviours pull in opposite directions, and **both fail silently**:

| Rule | Why | Failure if broken |
|---|---|---|
| id must **contain** `claude` or `anthropic` | `/v1/models` discovery filters on it | model never appears in `/model`, no error |
| id must **not start with** `claude-` | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only applies to ids that don't | Claude Code assumes a **200K** window for your 16K model and never compacts in time |

Hence `local-claude-qwen3.5-9b`. The registry rejects a non-conforming id at startup
rather than letting either failure happen quietly at runtime.

### Prompt and output share one window

Claude Code was measured requesting **`max_tokens: 32000`** — sized for a frontier
model. On a 16K local context the prompt and the output come out of the *same*
budget, so forwarding that overflows before a token is generated. Capping at the full
context window is equally wrong. The gateway clamps `max_tokens` to what the prompt
did not already consume, and when a prompt genuinely does not fit it fails with the
upstream's own `prompt is too long` wording, which is what Claude Code matches on to
trigger compaction and retry.

### Claude Code sends a mid-conversation `system` message

Partway through a session Claude Code appends a `role: "system"` message to the **end**
of `messages[]`. Qwen3.5's chat template hard-raises `System message must be at the
beginning`, llama-server returns a 500, and — observed directly — **Claude Code then
retried the identical request 11 times**, because a raw Jinja error is not wording its
recovery path recognises. The gateway re-labels such a message as `user`, preserving
its position and leaving the prompt prefix untouched.

### A model swap must not go silent

Claude Code counts every relayed byte and **aborts a stream silent for 300 seconds**.
A swap costs 10–90 s with no upstream to relay from. The gateway commits the
`text/event-stream` headers *first*, then emits SSE **comment lines** through the whole
swap — invisible to parsers, but bytes on the wire. Measured on a cold load: first
byte at **0.07 s**, max silent gap **5.1 s**.

The cost is that the status code is then committed, so a swap that fails afterwards
is delivered as an in-stream `event: error` rather than a 503.

### Fields that are hard 400s upstream

`context_management`, `output_config`, and the tool schema fields `strict` /
`defer_loading`. The gateway is **tolerant inbound, strict outbound**: it never rejects
an unknown field from Claude Code, and builds the upstream body from an explicit
allowlist.

`thinking` is dropped for a different reason, and the reason changed. It was recorded
here as a hard 400 for `{"type":"adaptive"}`; on the current llama.cpp that no longer
reproduces. Probed directly against the backend, all of `adaptive`, `disabled` and
`enabled`+`budget_tokens` return **200 — and all of them come back with a thinking block
of much the same size, `disabled` included**. So the field is parsed and then ignored.

That is worth stating plainly because it closes an appealing design: Claude Code already
expresses a thinking preference (through `MAX_THINKING_TOKENS`, or "think" / "think
harder" in a prompt) and it would be natural to pass it through. It would do nothing.
Reasoning is therefore governed where it actually takes effect — `--reasoning` and
`--reasoning-budget` at spawn — which is what `/admin/reasoning` drives.

### A reasoning model will think its whole answer away

Qwen3.5 reasons by default under `--jinja`, and the chain of thought comes out of the
*same* window as the prompt and the reply. Asking the 2B for a one-line answer with
`max_tokens: 64` returned **64 thinking tokens and no text at all** — `stop_reason:
max_tokens`, nothing to show the user. Claude Code cannot suppress it either: the
`thinking` field it sends is ignored upstream, as above.

So the budget is set where it can be enforced — `--reasoning-budget` on the backend. Each
model gets a derived default (an eighth of its window, capped at 4096; zero for models
with no thinking mode), and it is adjustable within a range the gateway enforces, with
half the window as the ceiling:

```bash
curl -X POST 'localhost:8787/admin/reasoning?model=local-claude-qwen3.5-9b&budget=1024'
```

The value reaches `llama-server` as a spawn argument, so changing it evicts the running
backend and the next request reloads with the new budget.

#### Letting Claude Code drive it

Claude Code's own reasoning dial drives that budget. Claude
Code sends `output_config.effort` on **every** request, and the user sets it with
`CLAUDE_CODE_EFFORT_LEVEL` — so the intent arrives already expressed as five discrete
levels, with nothing to quantise:

| `CLAUDE_CODE_EFFORT_LEVEL` | Formula | 64K default model | 16K model |
|---|---|---|---|
| `low` | context ÷ 32 | 2048 | 512 |
| `medium` | context ÷ 16 | 4096 | 1024 |
| `high` *(what Claude Code sends by default)* | the model's own default | **4096** | **2048** |
| `xhigh` | context ÷ 4 | 16384 | 4096 |
| `max` | the ceiling, half the window | 32768 | 8192 |

The budgets scale with the window, so they moved when the default model went to 64K. Note
that `medium` and `high` coincide there — the derived default is an eighth of the window
capped at 4096, and a 64K window hits that cap.

The ladder is anchored so `high` lands exactly on the budget the model would have had
anyway: turning the feature on changes nothing until the user actually turns their dial.

It is **on by default**, and the anchoring is why that is safe: Claude Code sends `high`
whenever the user has expressed no preference, and `high` is the budget the model already
had. Measured over a twelve-request session with the dial untouched — twelve requests at
`high`, **zero budget changes, one backend spawn**. You pay nothing until you turn the
dial. Set `EFFORT_FOLLOWS_CLIENT=0` to ignore the client's level entirely.

The reason to care about that measurement is the reload: the budget is a spawn argument,
so a level change costs a backend restart.

A level therefore applies on the **first** request that carries it, and `EFFORT_STREAK`
(default `1`) can require it to hold for N consecutive requests first.

That default was `3` for a while, and it was the wrong call. A soak run once logged 36
effort changes and 35 backend reloads in a single phase, so a run of 3 was added to
starve an alternating client. But it did not help the case that actually happens: someone
who exports `CLAUDE_CODE_EFFORT_LEVEL` sends the *same* level on every request, so a
streak never avoids the reload — it postpones it to the third request and serves two
requests at a budget the user did not ask for. Same reload count, strictly worse output.

It only ever helped against alternation, and effort handling was never confirmed as the
cause of that alternation — a rerun with identical settings did not reproduce it. Charging
every user a two-request delay for an unconfirmed diagnosis is not a trade worth making,
so the knob stays and the default does not.

`thinking` cannot serve this purpose, despite Claude Code also sending it — it arrives as
`{"type":"adaptive"}` carrying no number, and llama-server ignores it either way.

### Tool schemas are the real context cost

In a measured request, tool definitions were **81%** of the payload (~23,400 of
~28,800 tokens); the system prompt was only 6%. Claude Code 2.1.236 sends ~27,800 tokens
before the conversation starts.

That number used to decide whether the project worked at all. Against the old 16K default
an unpruned session failed on its **first** message:

```
Prompt is too long · the request is ~27828 tokens (limit 15872) but this
conversation is only ~1519 tokens — the rest is system prompt, tool
definitions, and attachment content.
```

**The default model now has a 64K window, so pruning is optional again.** Verified with
no `TOOL_PROFILE` and no `--tools`: plan mode, write a file, and read-then-edit all
succeed. Prune when you want the speed — a smaller prefix is less to prefill every turn —
not because you have to.

Two ways, and they take the same tool names:

```bash
claude --tools "Read,Edit,Grep,Glob,Bash"          # client-side, 73% reduction
TOOL_PROFILE="Read,Edit,Grep,Glob,Bash"            # gateway-side, identical set
TOOL_PROFILE=coding                                # or a named shorthand
```

`TOOL_PROFILE` takes **any** comma-separated list, case-insensitively, including MCP
tools (`mcp__server__tool`) — the named profiles are just shorthands over the same
mechanism:

| Profile | Tools |
|---|---|
| `analysis` | read, glob, grep, bash, powershell, todowrite |
| `coding` | those plus write, edit, notebookedit |
| `full` | no pruning (the default) |

A single bare word is read as a **profile name**, never as a one-tool list — `Read` alone
is far more likely a mistyped profile than a genuine wish for exactly one tool, and
reading it as a list would prune everything else away. Write `Read,` for a list of one.
An unrecognised value warns at startup and falls back to no pruning; it used to be a
silent no-op that surfaced later as `prompt is too long`, pointing nowhere near the typo.

Pruning is deterministic and order-preserving, so it cannot defeat the prompt cache.

Also set `CLAUDE_CODE_ATTRIBUTION_HEADER=0`: a varying prompt prefix makes llama.cpp
log `forcing full prompt re-processing due to lack of cache data` on every turn.

## About Kimi

This project started as "run Kimi K3 and K2.7 locally". It cannot be done on consumer
hardware, and the arithmetic is worth writing down:

| Model | Smallest published quant |
|---|---|
| Kimi K3 (2.8T total / 104B active) | ~1.5 TB @ MXFP4 |
| Kimi K2.7 Code (1T / 32B active) | **295 GB** (IQ2_XXS); 639 GB @ Q4_K_M |

On a machine with 8 GB VRAM + 16 GB RAM (~23 GB total), K2.7's smallest quant is ~13×
the available memory and does not fit on a typical disk. K3 is ~5× larger again.

Moonshot's models that *do* fit are `Moonlight-16B-A3B` and `Kimi-VL-A3B`. Neither can
drive Claude Code — and that is not a guess. `Moonlight-16B-A3B-Instruct`'s
`tokenizer_config.json` chat template was inspected directly: it handles only
`system`/`user`/`assistant` content, with **no `tools` variable and no `tool_calls`
branch**, so llama.cpp's `--jinja` tool calling has nothing to bind to. `Kimi-Linear-48B`
needs 18 GB at a degraded Q2_K plus a non-mainline llama.cpp branch.

**No Moonshot model both fits consumer hardware and can drive Claude Code.** Hence a
general local gateway instead.

## Model catalog

`config/models.yaml`. Sizes are measured from the actual GGUF files.

**Every shipped model supports tool calling.** Claude Code is a tool loop, and a model
without tool support does not degrade gracefully — it fails as an opaque upstream
error that Claude Code retries a dozen times. Those models are documented below
rather than put in the picker.

| Tier | Model | Size | Context | Notes |
|---|---|---|---|---|
| `vram` | **Qwen3.5-9B** (default) | 5.56 GB | **64K** | 327 tok/s prefill, 56–60 decode |
| `vram` | Qwen3.5-9B + vision | 5.56 GB | 16K | same weights + mmproj; only if you send images |
| `vram` | Qwen3.5-4B | 2.71 GB | 32K | good background-model choice |
| `vram` | Qwen3.5-2B | 1.25 GB | 32K | too small for long agent loops |
| `stretch` | Qwen3.6-35B-A3B | 15.69 GB | 16K | 73.4% SWE-bench; best quality reachable on 8 GB |
| `stretch` | Qwen3.5-27B | 16.41 GB | 8K | dense; single-digit tok/s once it spills |

`vram` fits in GPU memory; `offload` spills to system RAM; `stretch` needs more than a
default Docker Desktop / WSL2 VM is given. The gateway probes real VRAM and RAM at
startup and marks anything that cannot fit unavailable, **naming the shortfall in GB**.

### Importing your own model, step by step

That catalog was chosen for one 8 GB laptop, which is no basis for deciding what your
hardware may run. Adding your own takes four fields and one command. **Nothing is
rebuilt and no file is bind-mounted.**

**1. Find a GGUF repo on Hugging Face.** You need `org/repo:QUANT`. Browse
<https://huggingface.co/models?library=gguf>, or start from a known publisher such as
[unsloth](https://huggingface.co/unsloth) or
[bartowski](https://huggingface.co/bartowski). The quant is the suffix on the `.gguf`
filename — `Q4_K_M`, `UD-Q4_K_XL`, `Q5_K_M`. `Q4_K_M` is the usual quality/size
compromise. So `unsloth/Qwen3-0.6B-GGUF` + `Q4_K_M` → `unsloth/Qwen3-0.6B-GGUF:Q4_K_M`.

**2. Get the four numbers you have to supply.**

| Field | Where it comes from |
|---|---|
| `size_gb` | the file size on the repo's *Files* tab, in GB |
| `context` | see below — this is the one people get wrong |
| `capabilities` | `tools` is required for Claude Code; add `thinking` for a reasoning model, `vision` only if you send images |
| `id` | must contain `claude` and must not start with `claude-`; the gateway rejects anything else |

**Choosing `context`.** It is *your* choice, not a property of the model — it becomes
`-c` on the llama-server command line, and it costs VRAM. The model card gives the
trained maximum (often 128K or more); what you can afford is usually far less. Budget it:

```
VRAM needed ≈ size_gb + (context ÷ 1024 × 22 MiB) + 400 MiB   [+ 1130 MiB if vision]
```

The 22 MiB per 1K tokens is measured on Qwen3.5 with `--cache-type-k/v q8_0`, and it is
**twice that** if you omit those args, because an unquantised KV cache is about double.
Start with 32768; the gateway marks the entry unavailable and names the shortfall in GB
if it will not fit, so guessing high is safe — it fails at *add* time, not at load time.

**3. Add it.** `POST /admin/models` validates the id, checks the Hugging Face repo
actually exists, and sizes it against your hardware:

```bash
curl -X POST localhost:8787/admin/models -H 'content-type: application/json' -d '{
  "id": "local-claude-qwen3-06b",
  "display_name": "Qwen3 0.6B",
  "hf": "unsloth/Qwen3-0.6B-GGUF:Q4_K_M",
  "size_gb": 0.4,
  "context": 32768,
  "capabilities": ["tools", "thinking"],
  "tier": "vram"
}'

```

A `201` reports whether it fits, and names the shortfall if not:

```json
{"id":"local-claude-qwen3-06b","available":true,"unavailable_reason":null,
 "reasoning_budget":4096,
 "weights":"not downloaded yet - POST /admin/models/pull?model=local-claude-qwen3-06b"}
```

**4. Download the weights.** Optional — they are fetched on first use anyway — but doing
it now streams progress rather than making your first real request look hung:

```bash
curl -N -X POST 'localhost:8787/admin/models/pull?model=local-claude-qwen3-06b'
# pulling local-claude-qwen3-06b
# downloading / loading model ...
# ok: local-claude-qwen3-06b ready in 34145ms
# released; the weights stay in the cache for the next request
```

The pull *loads* the model as well as fetching it, which is the only way to prove the
weights are usable rather than merely present. It releases the backend afterwards.

**5. Use it.** It appears in `/model` immediately, no restart:

```bash
curl -s 'localhost:8787/admin/client-env?format=sh&model=local-claude-qwen3-06b' \
  | grep ^export        # eval this to point Claude Code at it
curl -X DELETE 'localhost:8787/admin/models?model=local-claude-qwen3-06b'   # or forget it
```

The entry is written to `custom-models.yaml` **in the model volume**, beside the weights
it describes, so it survives `docker rm` exactly as long as the download does. Deleting
an entry leaves the weights in the cache.

Using a GGUF you already have on disk? Mount it and pass `path` instead of `hf`:

```bash
docker run ... -v /my/models:/models/mine claude-code-local-llm
curl -X POST localhost:8787/admin/models -H 'content-type: application/json' \
  -d '{"id":"local-claude-mine","path":"/models/mine/model.gguf","size_gb":4,
       "context":32768,"capabilities":["tools"],"tier":"vram"}'
```

Three things this deliberately checks:

- **The repo exists.** A typo used to be accepted with a `201` and only surface at pull
  time as llama.cpp's `exactly one out metadata, path_model, and file must be defined` —
  which never mentions the repo name. Now it is a `400` naming it. Add `?verify=0` to
  skip the lookup on an air-gapped host; an unreachable Hugging Face is treated as
  "cannot say" and accepts the model either way.
- **The id follows Claude Code's rules** — it must contain `claude` and must not start
  with `claude-`. Both failures are silent at runtime rather than errors: one drops the
  model from the `/model` picker, the other makes the client assume a 200K window.
- **It fits.** A model too large for the host is still added, but reported unavailable
  with the shortfall in GB — you may be about to raise `MEMORY_BUDGET_GB`.

Entries in `config/models.yaml` stay under version control and cannot be deleted through
the API; only models you added at runtime can. A runtime model also cannot claim
`default` — the catalog owns that choice.

### Models that cannot drive Claude Code

These run fine under `llama.cpp` and are useful for completion or chat, but their chat
templates have no `tools` branch, so they cannot emit `tool_use` blocks. Add them to
`config/models.yaml` if you want them — the gateway will serve them and flag them —
but Claude Code's agent loop will not work:

```yaml
  - id: local-claude-moonlight-16b-a3b      # Moonshot AI, 16B MoE / 3B active
    hf: mmnga/Moonlight-16B-A3B-Instruct-gguf:Q4_K_M
    size_gb: 9.81
    context: 8192
    capabilities: []                         # <- no tool support
    tier: offload
    args: ["-ngl", "999", "--n-cpu-moe", "99", "-fa", "on", "--parallel", "1"]

  - id: local-claude-qwen2.5-coder-7b        # 88.4% HumanEval, fill-in-the-middle
    hf: unsloth/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M
    size_gb: 4.36
    context: 16384
    capabilities: []
    tier: vram
    args: ["-ngl", "999", "-fa", "on", "--parallel", "1"]

  - id: local-claude-deepseek-coder-v2-lite
    hf: lmstudio-community/DeepSeek-Coder-V2-Lite-Instruct-GGUF:Q4_K_M
    size_gb: 9.65
    context: 8192
    capabilities: []
    tier: offload
    args: ["-ngl", "999", "--n-cpu-moe", "99", "-fa", "on", "--parallel", "1"]
```

### Measured on an RTX 3070 Ti Laptop (8 GB), Qwen3.5-9B UD-Q4_K_XL

| | |
|---|---|
| Prefill | 327 tok/s |
| Decode | 56–60 tok/s |
| Cold load to first token | 19.4 s |
| Full Claude Code read+edit task | 41 s |

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | inference (also `?beta=true`) |
| `POST /v1/messages/count_tokens` | token counting; estimates rather than forcing a load |
| `GET /v1/models` | discovery for the `/model` picker |
| `/api/hello` | connection-warming probe; answers any method |
| `GET /health` | state, backend status, recent backend logs |
| `GET /admin/models` | catalog with capability and availability flags |
| `POST /admin/models` | add a model the image never shipped (see below) |
| `DELETE /admin/models` | forget a model you added: `?model=<id>` |
| `POST /admin/models/pull` | download the weights now: `?model=<id>`, streams progress |
| `GET /admin/client-env` | the exact Claude Code config for a model (`?format=sh\|ps1`) |
| `POST /admin/preload` | load a model without issuing a request |
| `GET /admin/reasoning` | thinking budget per model, with the allowed range |
| `POST /admin/reasoning` | change one, live: `?model=<id>&budget=N` |
| `GET /admin/metrics` | spawn/swap counts, config |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | gateway port |
| `BACKEND_PORT` | `8080` | llama-server port (loopback only) |
| `LLAMA_SERVER_BIN` | `llama-server` | path to the binary |
| `LLAMA_CACHE` | `./models` | GGUF cache; mount this as a volume |
| `MODELS_CONFIG` | `./config/models.yaml` | catalog path |
| `IDLE_TTL_SECONDS` | `900` | unload after idle; `0` disables |
| `BACKGROUND_STRATEGY` | `reuse-primary` | how an unrecognised model id is handled |
| `TOOL_PROFILE` | unset (`full`) | `coding` \| `analysis` \| any comma-separated tool list; unknown values warn and fall back |
| `GATEWAY_API_KEY` | unset | secret clients must send; setting it enables auth |
| `REQUIRE_AUTH` | `0` | enforce auth; requires `GATEWAY_API_KEY` or startup fails |
| `EFFORT_FOLLOWS_CLIENT` | `1` | let Claude Code's `effort` pick the thinking budget |
| `EFFORT_STREAK` | `1` | consecutive requests a level must hold before it is applied; `1` applies it at once |
| `ALLOW_CPU` | `0` | start without a GPU. For trying the gateway out only - see below |
| `MEMORY_BUDGET_GB` | detected | override the RAM budget when detection is wrong |
| `CAPTURE_DIR` | unset | record request bodies for contract tests (see below) |

`BACKGROUND_STRATEGY` exists because Claude Code drives two model slots — a main model
and a background one for side tasks. The background slot defaults to a real Anthropic
id that a local catalog never contains, so without this every side task would evict
the main model and evict it back. `reuse-primary` serves unrecognised ids from
whatever is already loaded. An **explicitly chosen** id is always honoured.

`GATEWAY_API_KEY` is the secret; `REQUIRE_AUTH` only turns enforcement on. Setting the
key is enough on its own, and `REQUIRE_AUTH=1` without a key refuses to start — a
presence-only check accepts any non-empty string, which is what an attacker sends. Auth
covers `/v1/*` and `/admin/*`; `/health` stays open so container healthchecks work.

`ALLOW_CPU` exists because no GPU is usually a *misconfiguration*, not a decision — a
missing `--gpus all`, an absent NVIDIA Container Toolkit, a CUDA image that does not
match the host driver, or a laptop dGPU switched off for power. So the default is to
refuse and name the likely fix.

### CPU is not a slower tier — past a point it cannot finish a request

Worth stating precisely, because "slow" undersells it. Measured in this container with
the GPU withheld, on the same request: a Claude Code system prompt plus fifteen tool
schemas, ~6,660 tokens.

| | Cold | Warm (identical prefix cached) |
|---|---|---|
| GPU, 9B | 21.4 s | 2.5 s |
| CPU, 2B | 111 s | 2.1 s |
| **CPU, 9B** | **never completed — killed at 5 min 13 s** | — |

The backend's own timing explains it: **prompt processing runs at ~18 tok/s on CPU**
(`n_tokens = 4096, t = 230.57 s / 17.76 tokens per second`). A ~6,600-token prompt
therefore needs roughly **370 s to prefill** — and Claude Code abandons a stream that has
been silent for **300 s**. The model large enough to drive Claude Code cannot prefill a
realistic request before the client gives up.

Prefill, not decode, is the wall. Decode on the 2B looks fine in isolation (~15 tok/s),
which is exactly why a quick test misleads — an agent loop re-prefills every turn.

`ALLOW_CPU=1` is therefore for *trying the gateway out* — checking the endpoints, seeing
a model load — not for real sessions.

### A small window cannot always compact its way out

Auto-compaction fires when the conversation approaches `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
and on a 16K local model it fires often. But the compaction request contains the whole
conversation, so once the conversation genuinely overflows, **the compaction request
overflows too** and there is no automatic way back:

```
request (20833 tokens) exceeds the available context size (16384 tokens)
Prompt is too long · automatic compaction failed
```

That is a property of a small window, not a gateway bug — but **"small" is a setting, not
a fact about the model**. `context:` in `config/models.yaml` becomes `-c` on the
llama-server command line, and it is yours to choose. This README used to present 16K as
a constraint to work around; it was a number nobody had re-examined. Raising the default
9B to 64K cost *less* VRAM than it had been using, because dropping the vision projector
paid for the extra KV cache. If you are hitting this section, widen the window before you
work around it — see [Importing your own model](#importing-your-own-model-step-by-step)
for the VRAM arithmetic.

Where the window genuinely is the limit, the gateway's job is to make it legible:
`sanitize.ts` rejects an over-long prompt up front with the `prompt is too long` wording
Claude Code's recovery keys on, and when its fast byte-based estimate lets one through —
dense content such as base64 or minified assets tokenises worse than the estimate
assumes — the upstream `exceed_context_size_error` is translated into the same wording
rather than surfacing as a generic server fault.

Practically: prefer a model with a larger window for long sessions, and start a fresh
session rather than fighting one that has already overflowed.

### Capturing what Claude Code actually sends

`CAPTURE_DIR` writes every inbound `/v1/messages` body to disk as `req-0001.json`,
`req-0002.json`, and so on. It is the tap that produced every fixture in `test/fixtures/`
and found every client behaviour documented above — the request body grows with each
Claude Code release, and reading it beats reading the spec.

The write happens *before* the model is loaded, so you can harvest real traffic without
spending a single GPU token.

```bash
docker run --gpus all -p 8787:8787 -v llm-models:/models \
  -v captures:/captures -e CAPTURE_DIR=/captures claude-code-local-llm
```

`/captures` exists in the image and is owned by the gateway user. Any other path at the
filesystem root is **not** writable — the gateway runs unprivileged — so the startup
check refuses to run rather than let the capture silently go nowhere. Drop the `-v` if
you only want the captures for the life of the container.

> **Captures are not safe to commit as-is.** A body carries the full system prompt, your
> file paths, and `metadata.user_id` — which contains a client device-id hash. Scrub
> those before turning a capture into a fixture or attaching one to an issue.

### Memory

The gateway reads the cgroup limit, so `docker run --memory=8g` is understood and models
that no longer fit are marked unavailable rather than loaded and OOM-killed. What it
*cannot* see is the WSL2 ceiling: on Windows, Docker Desktop's VM gets roughly half of
host RAM by default, and neither `os.totalmem()` inside the VM nor the cgroup reports the
share you actually have. Set `MEMORY_BUDGET_GB` to that number.

At ~8 GB the `vram` tier is comfortable and the `stretch` tier is not. To reach it, raise
the VM cap in `%USERPROFILE%\.wslconfig` and restart with `wsl --shutdown`:

```ini
[wsl2]
memory=12GB
```

On a 16 GB laptop that leaves Windows ~4 GB, which is tight — the stretch models are
listed because they fit, not because they will feel good.

## Container

Weights are **not** baked into the image; `llama-server` downloads them into the volume
on first use, so the image stays image-sized and survives upgrades.

**There is one image.** It is CUDA-based and needs the NVIDIA Container Toolkit on Linux,
or Docker Desktop with WSL2 GPU support on Windows.

```bash
docker build -t claude-code-local-llm .
```

### Every way to run it

A container gets GPU access **only at creation time**. Nothing you do to an existing
container can add it — `docker start` on a container built without it reproduces the
failure forever. Pick one of these:

| | Command | GPU |
|---|---|---|
| **Compose** *(recommended)* | `docker compose up -d` | ✓ reserved in `docker-compose.yml` |
| CLI, explicit | `docker run --gpus all -p 8787:8787 -v llm-models:/models claude-code-local-llm` | ✓ |
| CLI, via runtime | `docker run --runtime=nvidia -p 8787:8787 -v llm-models:/models claude-code-local-llm` | ✓ |
| **Docker Desktop UI** | the Run button | ✗ **unless you do the one-time setup below** |
| CPU only | add `-e ALLOW_CPU=1` to any of the above | n/a — [and barely usable](#cpu-is-not-a-slower-tier--past-a-point-it-cannot-finish-a-request) |

### Making the Docker Desktop Run button work

The Run button passes no GPU flag and offers no field for one, so by default the gateway
finds no GPU and refuses to start. One host setting fixes it for **every** container,
permanently — this image already sets `NVIDIA_VISIBLE_DEVICES=all` (inherited from the
CUDA base), so the runtime is the only missing piece:

**Settings → Docker Engine**, add `"default-runtime": "nvidia"`, then **Apply & restart**:

```json
{
  "default-runtime": "nvidia",
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  }
}
```

Verified here: with `--runtime=nvidia` and **no** `--gpus` flag, the gateway reports
`vramTotalMb=8191` while `HostConfig.DeviceRequests` is `null` — the runtime alone
grants the GPU. Making it the default extends that to containers the UI creates.

To check whether a container you already have has GPU access:

```bash
docker inspect <name> --format '{{json .HostConfig.DeviceRequests}}'  # null = no GPU
docker inspect <name> --format '{{.HostConfig.Runtime}}'              # nvidia = has it
```

<details>
<summary>Why there is no separate <code>:cpu</code> image to pull</summary>

There was going to be one — it is 1.55 GB against 7.65 GB, since ~91% of the GPU image
is CUDA runtime. Then the CPU path was actually measured, and it turned out to serve
nobody: prefill runs at ~18 tok/s, a realistic Claude Code prompt needs ~370 s of it, and
the client gives up at 300 s. A smaller download of something that cannot complete a
request is not a kindness. See
[CPU is not a slower tier](#cpu-is-not-a-slower-tier--past-a-point-it-cannot-finish-a-request).

The CUDA image runs CPU-only perfectly well when you *do* want to poke at it — no GPU
flag, `ALLOW_CPU=1`, verified working:

```bash
docker run -e ALLOW_CPU=1 -p 8787:8787 -v llm-models:/models claude-code-local-llm
```

And the CPU **build** is still supported, because it is a cheap structural test of this
Dockerfile that does not pull 7 GB — `docker compose --profile cpu up -d`, or:

```bash
docker build --build-arg BASE_IMAGE=ghcr.io/ggml-org/llama.cpp@sha256:1394ab6c8e418859b282ff5a38a218ab318b2b4de8848c611b92e92017d6d8e4 \
  -t claude-code-local-llm:cpu .
```
</details>

**The base image is pinned by digest.** `src/resources.ts` discovers VRAM by parsing the
exact text of `llama-server --list-devices`; a base rebase that reformats that output
would make every model look unavailable, with nothing in the logs pointing at the cause.
The pinned CUDA digest is the one this project was verified against (llama.cpp `b10795`).
Moving to a newer base means repointing it *and* re-running the GPU check — that the
build succeeds proves nothing about the parse.

When building an image to publish, pass provenance so it can be traced back to a commit:

```bash
docker build -t <user>/claude-code-local-llm:<tag> \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
```

Both default to empty rather than to an invented value, and the image sets its own
OCI labels — without them it would inherit the base image's and advertise itself as
NVIDIA's `llama.cpp`.

Then point Claude Code at it exactly as in the Quickstart. `/admin/client-env` reports
the container's own `PORT`, so if you publish it on a different host port
(`-p 9000:8787`), edit `ANTHROPIC_BASE_URL` to match.

## Development

```bash
npm install
npm run typecheck
npm test          # 89 tests, incl. contract tests over real captured traffic
./run-gateway.sh
```

Fixtures in `test/fixtures/` are real request bodies captured from Claude Code, not
hand-written approximations — the body Claude Code sends grows with each release, and
every bug above was found by reading captured traffic rather than the spec.

## License

MIT — see [LICENSE](LICENSE).

**No model weights are shipped** in this repository or in the image. The catalog is a
list of pointers, and `llama-server` downloads weights into your volume on first use, so
each model's license binds you at download time. All five catalog models are Apache-2.0.
Full breakdown, including the CUDA runtime's separate terms in the GPU image, in
[MODEL_LICENSES.md](MODEL_LICENSES.md).
