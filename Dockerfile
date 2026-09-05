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
#     docker build --build-arg BASE_IMAGE=ghcr.io/ggml-org/llama.cpp:server \
#       -t claude-local-llm:cpu .
#     docker run -e ALLOW_CPU=1 -p 8787:8787 -v llm-models:/models claude-local-llm:cpu
#
# The two variants differ ONLY in the base image, so they share this file. They used to
# be two files whose 87 lines had to be kept identical by hand - which is a bug waiting
# for the day someone edits one of them.
#
# Weights are NOT baked in. llama-server downloads them into LLAMA_CACHE on first use,
# so the image stays image-sized and the volume survives upgrades.

# Which llama.cpp image the runtime stage is built on:
#
#   :server-cuda    CUDA 12 drivers (default)
#   :server-cuda13  CUDA 13 drivers
#   :server         CPU only
#
# Declared HERE, before any FROM, because that is the only scope a FROM can read an ARG
# from. Declaring it next to the runtime FROM instead puts it inside the build stage,
# and the base name silently resolves to empty:
#   ERROR: base name (${BASE_IMAGE}) should not be blank
#
# PIN THIS BEFORE PUBLISHING. The tag floats, and src/resources.ts parses the exact text
# of `llama-server --list-devices` to discover VRAM. A base rebase that reformats that
# output makes every model look unavailable, with nothing in our logs pointing at the
# cause. Pin by digest once a build is verified:
#   ARG BASE_IMAGE=ghcr.io/ggml-org/llama.cpp@sha256:<digest>
ARG BASE_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda

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
#   :server-cuda    CUDA 12 drivers (default)
#   :server-cuda13  CUDA 13 drivers
#   :server         CPU only
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
RUN mkdir -p /models && useradd --system --uid 10001 --home /app gateway \
    && chown -R gateway:gateway /app /models
VOLUME ["/models"]

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    BACKEND_PORT=8080 \
    GATEWAY_ROOT=/app \
    MODELS_CONFIG=/app/config/models.yaml \
    LLAMA_CACHE=/models \
    LLAMA_SERVER_BIN=/usr/local/bin/llama-server

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
