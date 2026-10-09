#!/usr/bin/env bash
# KILL SWITCH: stop every agent and the server immediately, and stop the schedule waking it.
# Usage: scripts/killswitch.sh [--profile agentcraft]
set -euo pipefail
PROFILE="${AWS_PROFILE_NAME:-agentcraft}"; [[ "${1:-}" == "--profile" ]] && PROFILE="$2"
export AWS_REGION=eu-north-1 AWS_PAGER=""
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
A=(--profile "$PROFILE" --region eu-north-1)
ASG=agentcraft-host
echo "1/3 stopping the stack on any running host (fast, keeps the world safe)"
IDS=$(aws "${A[@]}" ec2 describe-instances --filters Name=tag:project,Values=agentcraft Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$IDS" ]; then
  # shellcheck disable=SC2086
  aws "${A[@]}" ssm send-command --instance-ids $IDS --document-name AWS-RunShellScript \
    --parameters 'commands=["cd /opt/agentcraft/infra/docker && docker compose stop -t 30 && echo stopped"]' \
    --comment "agentcraft killswitch" --query Command.CommandId --output text || echo "  (SSM stop failed; scale-in below still stops the host)"
fi
echo "2/3 scaling the host to zero and blocking the schedule"
aws "${A[@]}" autoscaling suspend-processes --auto-scaling-group-name "$ASG" --scaling-processes ScheduledActions
aws "${A[@]}" autoscaling update-auto-scaling-group --auto-scaling-group-name "$ASG" --min-size 0 --max-size 0 --desired-capacity 0
echo "3/3 done. World volume and backups are untouched. Resume with scripts/resume.sh"
