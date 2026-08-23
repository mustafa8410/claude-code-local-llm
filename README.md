# claude-local-llm

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

`thinking: {"type":"adaptive"}` (sent for *any* id Claude Code doesn't recognise —
which is every gateway alias), `context_management`, `output_config`, and the tool
schema fields `strict` / `defer_loading`. The gateway is **tolerant inbound, strict
outbound**: it never rejects an unknown field from Claude Code, and builds the upstream
body from an explicit allowlist.

### Tool schemas are the real context cost

In a measured request, tool definitions were **81%** of the payload (~23,400 of
~28,800 tokens); the system prompt was only 6%. The highest-leverage fix is
client-side — `claude --tools "Read,Edit,Grep,Glob,Bash"`, measured at a 73%
reduction. `TOOL_PROFILE` does it gateway-side when the launch command can't change;
pruning is deterministic and order-preserving so it can't defeat the prompt cache.

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
| `vram` | **Qwen3.5-9B** (default) | 5.56 GB | 16K | 327 tok/s prefill, 56–60 decode |
| `vram` | Qwen3.5-4B | 2.71 GB | 32K | good background-model choice |
| `vram` | Qwen3.5-2B | 1.25 GB | 32K | too small for long agent loops |
| `stretch` | Qwen3.6-35B-A3B | 15.69 GB | 16K | 73.4% SWE-bench; best quality reachable on 8 GB |
| `stretch` | Qwen3.5-27B | 16.41 GB | 8K | dense; single-digit tok/s once it spills |

`vram` fits in GPU memory; `offload` spills to system RAM; `stretch` needs more than a
default Docker Desktop / WSL2 VM is given. The gateway probes real VRAM and RAM at
startup and marks anything that cannot fit unavailable, **naming the shortfall in GB**.

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
| `HEAD /api/hello` | connection-warming probe |
| `GET /health` | state, backend status, recent backend logs |
| `GET /admin/models` | catalog with capability and availability flags |
| `GET /admin/client-env` | the exact Claude Code config for a model (`?format=sh\|ps1`) |
| `POST /admin/preload` | load a model without issuing a request |
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
| `TOOL_PROFILE` | unset | `full` \| `coding` \| `analysis` \| comma-separated list |
| `REQUIRE_AUTH` | `0` | require a client credential |
| `CAPTURE_DIR` | unset | record request bodies for contract tests |

`BACKGROUND_STRATEGY` exists because Claude Code drives two model slots — a main model
and a background one for side tasks. The background slot defaults to a real Anthropic
id that a local catalog never contains, so without this every side task would evict
the main model and evict it back. `reuse-primary` serves unrecognised ids from
whatever is already loaded. An **explicitly chosen** id is always honoured.

## Development

```bash
npm install
npm run typecheck
npm test          # 17 tests, incl. contract tests over real captured traffic
./run-gateway.sh
```

Fixtures in `test/fixtures/` are real request bodies captured from Claude Code, not
hand-written approximations — the body Claude Code sends grows with each release, and
every bug above was found by reading captured traffic rather than the spec.

## License

MIT
