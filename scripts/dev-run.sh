#!/usr/bin/env bash
# Run agents (and optionally ops) locally against a dev Paper server on 127.0.0.1:25565.
# Usage: scripts/dev-run.sh <seconds> [agent ...]   (default: all agents)
# Env: DISCORD_DRY_RUN=1 (default) prints chat instead of posting; set 0 to post for real.
set -euo pipefail
cd "$(dirname "$0")/.."
SECS="${1:-300}"; shift || true
AGENTS=("$@"); [[ ${#AGENTS[@]} -eq 0 ]] && AGENTS=(mags tobin wren)
DATA="${AGENTCRAFT_DATA_DIR:-/tmp/agentcraft-dev}"
LOGS="$DATA/logs"; mkdir -p "$LOGS"
# The build container injects invalid static AWS keys; use the aws-login profile instead.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
eval "$(aws configure export-credentials --profile "${AWS_PROFILE_NAME:-agentcraft}" --format env)"
export AGENTCRAFT_DATA_DIR="$DATA" MC_HOST=127.0.0.1 IGNORE_SEASON=1 NODE_USE_ENV_PROXY=1 \
       DISCORD_DRY_RUN="${DISCORD_DRY_RUN:-1}" RCON_PASSWORD="${RCON_PASSWORD:-devpass}" RCON_HOST=127.0.0.1
for a in "${AGENTS[@]}"; do
  AGENT_ID="$a" timeout "$SECS" node --no-warnings --max-old-space-size=448 agents/src/agent.js > "$LOGS/$a.log" 2>&1 &
  sleep 3
done
[[ "${WITH_OPS:-0}" == 1 ]] && timeout "$SECS" node --no-warnings ops/main.js > "$LOGS/ops.log" 2>&1 &
echo "running ${AGENTS[*]} for ${SECS}s; logs in $LOGS"
wait
