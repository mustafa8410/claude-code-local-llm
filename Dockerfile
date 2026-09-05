# claude-local-llm - one Dockerfile, GPU or CPU.
#
# One container, one port, one process tree: the Node gateway supervises llama-server
# as a child process. That is what makes the swap path work - stopping and starting a
# backend is a local operation, not an orchestration problem.
#
#   GPU (default):
#     docker build -t claude-local-llm .
#     docker run --gpus all -p 8787:8787 -v llm-models:/models claude-local-llm
#
#   CPU (expect single-digit tokens/sec; the gateway also needs ALLOW_CPU=1):
#     docker build --build-arg BASE_IMAGE=ghcr.io/ggml-org/llama.cpp@sha256:1394ab6c8e418859b282ff5a38a218ab318b2b4de8848c611b92e92017d6d8e4 \
#       -t claude-local-llm:cpu .
#     docker run -e ALLOW_CPU=1 -p 8787:8787 -v llm-models:/models claude-local-llm:cpu
#
# The two variants differ ONLY in the base image, so they share this file. They used to
# be two files whose 87 lines had to be kept identical by hand - which is a bug waiting
# for the day someone edits one of them.
#
# Weights are NOT baked in. llama-server downloads them into LLAMA_CACHE on first use,
# so the image stays image-sized and the volume survives upgrades.

# Which llama.cpp image the runtime stage is built on. Upstream publishes these tags:
#
#   :server-cuda    CUDA 12 drivers (what the default digest below points at)
#   :server-cuda13  CUDA 13 drivers
#   :server         CPU only
#
# Resolve a tag to a digest before building against it - `docker buildx imagetools
# inspect ghcr.io/ggml-org/llama.cpp:<tag>` prints one - so the build stays reproducible.
#
# Declared HERE, before any FROM, because that is the only scope a FROM can read an ARG
# from. Declaring it next to the runtime FROM instead puts it inside the build stage,
# and the base name silently resolves to empty:
#   ERROR: base name (${BASE_IMAGE}) should not be blank
#
# PINNED BY DIGEST, deliberately. The tag floats, and src/resources.ts parses the exact
# text of `llama-server --list-devices` to discover VRAM. A base rebase that reformats
# that output makes every model look unavailable, with nothing in our logs pointing at
# the cause - so a published image could break with no commit on our side.
#
# The digest below is the CUDA 12 base this project was actually verified against:
# llama.cpp build b10795, tag :server-cuda as of 2026-09-04. To move to a newer base,
# repoint it and re-run the GPU verification - `--list-devices` output is the thing to
# re-check, not just that the build succeeds.
ARG BASE_IMAGE=ghcr.io/ggml-org/llama.cpp@sha256:7f87a3bbe3143cdb857f5c84f82d2c15528be70ca0e7c5ade9a47d56b791f93f

# ---------------------------------------------------------------- build stage ----
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
RUN npm run build && npm prune --omit=dev

# -------------------------------------------------------------- runtime stage ----
# The official llama.cpp image already carries llama-server and, for the CUDA variant,
# the CUDA runtime - so we never compile llama.cpp ourselves.
#
# The BASE_IMAGE default is declared at the top of this file, before the first FROM.
# It has to be: an ARG declared inside a stage belongs to that stage, so a FROM cannot
# see it and the base name resolves to empty.
FROM ${BASE_IMAGE} AS runtime

ARG NODE_VERSION=22.20.0

# Node from the official tarball rather than a distro package: the base image tracks
# whatever Ubuntu the llama.cpp build used, and its Node package is far too old.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl xz-utils ca-certificates tini; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    apt-get purge -y curl xz-utils; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    node --version
# curl and xz-utils exist only to fetch and unpack that tarball, so both are purged.
# ca-certificates stays - llama-server needs it to download weights over HTTPS - and
# the healthcheck uses node's fetch rather than curl, so nothing at runtime wants it.

# The base image's llama-server location is an implementation detail of that image and
# has moved between releases. Resolve it at build time and pin a stable path, so a
# rebase does not silently break the supervisor's spawn.
RUN set -eux; \
    BIN="$(command -v llama-server || true)"; \
    if [ -z "$BIN" ]; then \
      BIN="$(find / -maxdepth 5 -type f -name llama-server -perm -u+x 2>/dev/null | head -n1)"; \
    fi; \
    test -n "$BIN"; \
    ln -sf "$BIN" /usr/local/bin/llama-server; \
    echo "llama-server resolved to $BIN"

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY config ./config

# Weights live on a volume so a container upgrade does not re-download several GB.
#
# /captures is created and owned here too, so `-e CAPTURE_DIR=/captures` - the obvious
# thing to type - actually works. The gateway runs as a non-root user, and it cannot
# create a directory at the filesystem root, so without this the capture silently goes
# nowhere. It is deliberately NOT declared as a VOLUME: capture is off by default, and a
# VOLUME line would make every single `docker run` spawn an anonymous volume nobody
# asked for. Mount one yourself (`-v caps:/captures`) when you want them to survive.
RUN mkdir -p /models /captures && useradd --system --uid 10001 --home /app gateway \
    && chown -R gateway:gateway /app /models /captures
VOLUME ["/models"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    BACKEND_PORT=8080 \
    GATEWAY_ROOT=/app \
    MODELS_CONFIG=/app/config/models.yaml \
    LLAMA_CACHE=/models \
    LLAMA_SERVER_BIN=/usr/local/bin/llama-server

# Provenance. Set these when publishing so the image can be traced back to a commit:
#   docker build -t <repo>:<tag> \
#     --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
#     --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
# They default to empty rather than to something invented, because a wrong commit is
# worse than no commit.
ARG SOURCE_COMMIT=""
ARG BUILD_DATE=""
# Keep in step with package.json.
ARG APP_VERSION="0.1.0"
# Re-declared: BASE_IMAGE is a global ARG, and a global is visible to FROM lines but NOT
# inside a stage until the stage asks for it again. Without this the base.name label
# below expands to an empty string.
ARG BASE_IMAGE

# EVERY label below overrides one inherited from the base image, and that is the whole
# point of the block. Unlabelled, this image advertises itself on a registry as
# `llama.cpp`, `LLM inference in C/C++`, maintained by NVIDIA, with a source URL
# pointing at ggml-org - because those are the base image's labels and labels are
# inherited. That misleads anyone who pulls it and misattributes the work in both
# directions. `base.name` is the honest way to say what it is built on.
LABEL org.opencontainers.image.title="claude-local-llm" \
      org.opencontainers.image.description="Anthropic-compatible gateway that runs local GGUF models behind Claude Code" \
      org.opencontainers.image.source="https://github.com/mustafa8410/claude-local-llm" \
      org.opencontainers.image.url="https://github.com/mustafa8410/claude-local-llm" \
      org.opencontainers.image.documentation="https://github.com/mustafa8410/claude-local-llm#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Mustafa Albayrak" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.ref.name="" \
      maintainer=""

USER gateway
EXPOSE 8787

# Reports "downloading"/"loading" long before it reports ok, so a cold first start is
# legible rather than looking hung. start-period covers the initial multi-GB fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The base image sets its own ENTRYPOINT to llama-server; clear it. tini reaps the
# llama-server children the supervisor spawns and kills, so they cannot become zombies.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/server.js"]
