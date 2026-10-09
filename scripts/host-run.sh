#!/usr/bin/env bash
# Run a shell command on the AgentCraft host via SSM and print its output.
# Usage: scripts/host-run.sh 'cd /opt/agentcraft/infra/docker && sudo docker compose ps'
set -euo pipefail
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
A=(--profile "${AWS_PROFILE_NAME:-agentcraft}" --region eu-north-1)
ID=$(aws "${A[@]}" ec2 describe-instances --filters Name=tag:project,Values=agentcraft Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ "$ID" != "None" ] || { echo "no running host"; exit 1; }
PARAMS=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["900"]}))' "$1")
C=$(aws "${A[@]}" ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript --parameters "$PARAMS" --query Command.CommandId --output text)
until s=$(aws "${A[@]}" ssm get-command-invocation --command-id "$C" --instance-id "$ID" --query Status --output text 2>/dev/null) && [[ "$s" != "Pending" && "$s" != "InProgress" && "$s" != "Delayed" ]]; do sleep 3; done
aws "${A[@]}" ssm get-command-invocation --command-id "$C" --instance-id "$ID" --query StandardOutputContent --output text
err=$(aws "${A[@]}" ssm get-command-invocation --command-id "$C" --instance-id "$ID" --query StandardErrorContent --output text); [ -n "$err" ] && [ "$err" != "None" ] && echo "stderr: $err" >&2
[ "$s" = "Success" ]
