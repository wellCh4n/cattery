#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/work/repo}"
PORT="${PORT:-4096}"

# clone repo if specified
if [ -n "${REPO_URL:-}" ]; then
  echo "[entrypoint] cloning ${REPO_URL}@${BRANCH:-main}"
  git clone --depth 1 --branch "${BRANCH:-main}" "${REPO_URL}" "${REPO_DIR}"
  cd "${REPO_DIR}"
fi

# write opencode config — point to external model API
mkdir -p ~/.config/opencode

# 支持 anthropic 风格和 openai 风格
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  API_BASE="${ANTHROPIC_BASE_URL}/v1"
  API_KEY="${ANTHROPIC_API_KEY:-}"
  NPM_PKG="@ai-sdk/anthropic"
else
  API_BASE="${OPENAI_BASE_URL:-}/v1"
  API_KEY="${OPENAI_API_KEY:-}"
  NPM_PKG="@ai-sdk/openai-compatible"
fi

cat > ~/.config/opencode/opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "custom": {
      "npm": "${NPM_PKG}",
      "name": "Custom",
      "options": {
        "baseURL": "${API_BASE}",
        "apiKey": "${API_KEY}"
      },
      "models": {
        "${MODEL:-claude-sonnet-4-6}": {
          "name": "${MODEL:-claude-sonnet-4-6}"
        }
      }
    }
  },
  "model": "custom/${MODEL:-claude-sonnet-4-6}"
}
EOF

# write system prompt if provided
if [ -n "${AGENT_PROMPT:-}" ]; then
  mkdir -p ~/.opencode/agent
  echo "${AGENT_PROMPT}" > ~/.opencode/agent/default.md
fi

echo "[entrypoint] starting opencode serve on port ${PORT}"
exec opencode serve --port "${PORT}" --hostname 0.0.0.0 --log-level DEBUG --print-logs
