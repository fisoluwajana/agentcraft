#!/usr/bin/env bash
# Stores the Discord bot tokens and server ID in AWS Secrets Manager (secret: agentcraft/discord).
# Tokens are read with hidden input and never appear in shell history, process arguments or the chat.
#
# Run in AWS CloudShell (eu-north-1) as root/admin of the AgentCraft account:
#   bash agentcraft/infra/aws/bootstrap/put-discord-secrets.sh
set -euo pipefail
export AWS_DEFAULT_REGION="eu-north-1" AWS_PAGER=""
SECRET_ID="agentcraft/discord"

read -rp  "Discord server (guild) ID: " GUILD_ID
read -rsp "System bot token (AgentCraft System): " SYSTEM_TOKEN; echo
AGENT_TOKENS=()
i=1
while true; do
  read -rsp "Agent bot token #${i} (press Enter when done): " t; echo
  [[ -z "$t" ]] && break
  AGENT_TOKENS+=("$t"); i=$((i + 1))
done
# Agent bot tokens are optional: agents post through channel webhooks unless dedicated bots are supplied.

umask 077
TMP="$(mktemp)"
trap 'shred -u "$TMP" 2>/dev/null || rm -f "$TMP"' EXIT
GUILD_ID="$GUILD_ID" SYSTEM_TOKEN="$SYSTEM_TOKEN" python3 - "${AGENT_TOKENS[@]}" >"$TMP" <<'PY'
import json, os, sys
print(json.dumps({
    "guild_id": os.environ["GUILD_ID"].strip(),
    "system_bot_token": os.environ["SYSTEM_TOKEN"].strip(),
    "agent_bot_tokens": [t.strip() for t in sys.argv[1:]],
}))
PY

if aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "file://${TMP}" >/dev/null
  echo "Updated ${SECRET_ID} (${#AGENT_TOKENS[@]} agent bots)."
else
  aws secretsmanager create-secret --name "$SECRET_ID" --secret-string "file://${TMP}" \
    --description "AgentCraft Discord bot tokens and guild ID" --tags Key=project,Value=agentcraft >/dev/null
  echo "Created ${SECRET_ID} (${#AGENT_TOKENS[@]} agent bots)."
fi
