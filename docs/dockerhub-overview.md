# claude-code-local-llm

**Run any local GGUF model behind Claude Code.**

An Anthropic-compatible gateway that sits in front of `llama.cpp`, hot-swaps models on
demand, and absorbs the Claude-Code-specific behaviours that otherwise make a local model
unusable as a backend.

```
Claude Code  ──►  gateway :8787  ──►  llama-server :8080  ──►  your GGUF
```

📖 **Full documentation:** https://github.com/mustafa8410/claude-code-local-llm

---

## Before you pull

| | |
|---|---|
| **Size** | ~7.7 GB (most of it the CUDA runtime) |
| **Platform** | `linux/amd64` |
| **GPU** | **NVIDIA required.** NVIDIA Container Toolkit on Linux, or Docker Desktop with WSL2 GPU support on Windows |
| **Model weights** | **not included** — downloaded on first use into a volume you keep (~5.6 GB for the default) |

It starts without a GPU only if you pass `ALLOW_CPU=1`, and that is for looking around
rather than working: CPU prefill measured ~18 tokens/sec, so a realistic Claude Code
prompt needs around 370 seconds and the client gives up at 300.

---

## Quickstart

```bash
docker run -d --gpus all -p 8787:8787 -v llm-models:/models \
  mustafa8410/claude-code-local-llm
```

Then open **http://localhost:8787** in a browser. The container serves its own
documentation — setup commands, the model catalog, every setting, worked examples — all
generated from the configuration actually in force.

Point Claude Code at it:

```bash
# bash / zsh
eval "$(curl -s 'http://localhost:8787/admin/client-env?format=sh' | grep ^export)"
```

```powershell
# PowerShell - note curl.exe, not curl
curl.exe -s "http://localhost:8787/admin/client-env?format=ps1" | Invoke-Expression
```

Then launch:

```bash
claude --tools "Read,Write,Edit,Bash,Glob,Grep,TodoWrite"
```

### ⚠️ That tool list is not optional

Claude Code sends ~36 tool definitions on **every** request. Measured on a 64K model,
writing a Tetris game in C, changing nothing else:

| | Tools sent | Room for conversation | Compactions | Result |
|---|---|---|---|---|
| unpruned | 38.7K tokens | 5.7K | 3+, constantly | 276 lines, 1 file |
| pruned | 2.6K tokens | 24.7K | **none** | 566 lines, 3 files |

A single tool definition accounted for 12.9K of that — a fifth of the whole window.
Without pruning there is effectively no room left for your conversation, and Claude Code
reports it as *"a file being read is likely too large"*, which points at the wrong thing.

Prefer the client-side flag above. To enforce it for every client instead:
`-e TOOL_PROFILE=coding`.

---

## Models

Ships a catalog of Qwen3.5/3.6 GGUF models (all Apache-2.0), sized for an 8 GB card. The
gateway probes your actual VRAM and RAM at startup and marks anything that will not fit
as unavailable, **naming the shortfall in GB** rather than failing at load time.

Add your own without rebuilding:

```bash
curl -X POST localhost:8787/admin/models -H 'content-type: application/json' -d '{
  "id": "local-claude-mymodel",
  "hf": "unsloth/Qwen3-0.6B-GGUF:Q4_K_M",
  "size_gb": 0.4, "context": 32768,
  "capabilities": ["tools"], "tier": "vram"
}'
```

The id must contain `claude` and must not start with `claude-` — both rules come from
Claude Code and both fail silently if broken. The gateway enforces them.

---

## Common settings

| Variable | Default | |
|---|---|---|
| `TOOL_PROFILE` | unset | `coding` \| `analysis` \| any tool list. **Unset means no pruning** |
| `GATEWAY_API_KEY` | unset | required credential. Setting it turns auth on — do this before exposing the port |
| `ALLOW_CPU` | `0` | start without a GPU |
| `MEMORY_BUDGET_GB` | detected | override when WSL2 misreports RAM |
| `CAPTURE_DIR` | unset | record request bodies for debugging |

Full list with current values: `curl localhost:8787/admin/config`, or the help page.

### Docker Desktop's Run button gives no GPU

GPU access is fixed when a container is **created**, and that button passes no `--gpus`
flag — so the gateway finds no GPU and refuses to start, and restarting cannot fix it.
Use `docker run --gpus all`, `docker compose up -d`, or make it the default for every
container: **Settings → Docker Engine**, add `"default-runtime": "nvidia"`.

---

## Licence

The gateway is MIT. **No model weights are shipped** — the catalog is a list of pointers,
so each model's licence binds you at download time. All catalogued models are Apache-2.0.
The GPU image carries NVIDIA's CUDA runtime under NVIDIA's own terms.

Full breakdown: https://github.com/mustafa8410/claude-code-local-llm/blob/main/MODEL_LICENSES.md
