# Licenses

## The important thing first: this image ships no model weights

`claude-code-local-llm` distributes a **catalog** — `config/models.yaml` is a list of pointers
to Hugging Face repositories. No GGUF file is baked into the image, and none is included
in this repository. `llama-server` downloads weights into your `/models` volume the first
time you use a model.

That means the model licenses below bind **you, at download time**, not this image at
publish time. If you add your own model through `POST /admin/models`, its license is
between you and whoever published it — the gateway does not check, and cannot.

## This project

| Component | License |
|---|---|
| `claude-code-local-llm` (this repository) | MIT — see [LICENSE](LICENSE) |

## The container's base images

The runtime stage is built on the official `llama.cpp` server image, pinned by digest in
the `Dockerfile`.

| Component | License |
|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT |
| Node.js 22 (official tarball) | MIT |
| `tini` | MIT |

**The GPU image additionally carries NVIDIA's CUDA runtime**, because
`ghcr.io/ggml-org/llama.cpp:server-cuda` is built on an NVIDIA CUDA base image. That
runtime is governed by NVIDIA's own terms, not by MIT — read them at
<https://docs.nvidia.com/cuda/eula/> before redistributing the GPU image. The CPU image
(`BASE_IMAGE=ghcr.io/ggml-org/llama.cpp@sha256:1394ab…`) has no CUDA component and no
such condition.

## Models in the shipped catalog

All five are Qwen models from Alibaba, quantised and republished in GGUF form by
[unsloth](https://huggingface.co/unsloth). **Every one is Apache-2.0.** Verified against
the Hugging Face model card metadata for each repository on 2026-09-05.

| Catalog id | Repository | Upstream model | License |
|---|---|---|---|
| `local-claude-qwen3.5-9b` | [unsloth/Qwen3.5-9B-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) | Qwen/Qwen3.5-9B | Apache-2.0 |
| `local-claude-qwen3.5-4b` | [unsloth/Qwen3.5-4B-GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) | Qwen/Qwen3.5-4B | Apache-2.0 |
| `local-claude-qwen3.5-2b` | [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) | Qwen/Qwen3.5-2B | Apache-2.0 |
| `local-claude-qwen3.6-35b-a3b` | [unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | Qwen/Qwen3.6-35B-A3B | Apache-2.0 |
| `local-claude-qwen3.5-27b` | [unsloth/Qwen3.5-27B-GGUF](https://huggingface.co/unsloth/Qwen3.5-27B-GGUF) | Qwen/Qwen3.5-27B | Apache-2.0 |

Apache-2.0 permits commercial use, modification and redistribution, and requires you to
keep the license and notices with any copy you pass on. The authoritative text for each
lives in its upstream repository, e.g.
<https://huggingface.co/Qwen/Qwen3.5-9B/blob/main/LICENSE>.

## Models the README mentions but does not ship

The README documents three models that run under `llama.cpp` but cannot drive Claude
Code, because their chat templates have no `tools` branch. They are **not** in the
catalog and are never downloaded unless you add them yourself. Their terms differ, and
one of them is not an open-source license:

| Repository | License |
|---|---|
| [unsloth/Qwen2.5-Coder-7B-Instruct-GGUF](https://huggingface.co/unsloth/Qwen2.5-Coder-7B-Instruct-GGUF) | Apache-2.0 |
| [mmnga/Moonlight-16B-A3B-Instruct-gguf](https://huggingface.co/mmnga/Moonlight-16B-A3B-Instruct-gguf) | MIT |
| [lmstudio-community/DeepSeek-Coder-V2-Lite-Instruct-GGUF](https://huggingface.co/lmstudio-community/DeepSeek-Coder-V2-Lite-Instruct-GGUF) | **DeepSeek License Agreement** — a custom license with use restrictions, not Apache/MIT. Read it before any commercial use. |

## Keeping this accurate

License metadata on Hugging Face can change when a repository is updated or relicensed.
If you change `config/models.yaml`, re-check the `license` field on each model card —
`https://huggingface.co/api/models/<org>/<repo>` returns it under `cardData.license` —
and update the table above.
