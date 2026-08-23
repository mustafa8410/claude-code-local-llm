#!/usr/bin/env bash
# Dev launcher: runs the gateway from source against the local llama.cpp build.
cd "$(dirname "$0")"
export LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$(pwd -W 2>/dev/null || pwd)/.tools/llama/llama-server.exe}"
export LLAMA_CACHE="${LLAMA_CACHE:-$(pwd -W 2>/dev/null || pwd)/models}"
export GATEWAY_ROOT="${GATEWAY_ROOT:-$(pwd -W 2>/dev/null || pwd)}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
exec node src/server.ts
