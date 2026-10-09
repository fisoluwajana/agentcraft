#!/usr/bin/env bash
# Always-on mode: agents play outside season hours and the host ignores the nightly schedule.
# Usage: scripts/always-on.sh on|off
set -euo pipefail
cd "$(dirname "$0")/.."
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
A=(--profile "${AWS_PROFILE_NAME:-agentcraft}" --region eu-north-1)
case "${1:-}" in
  on)  V=1; aws "${A[@]}" autoscaling suspend-processes --auto-scaling-group-name agentcraft-host --scaling-processes ScheduledActions
       aws "${A[@]}" autoscaling set-desired-capacity --auto-scaling-group-name agentcraft-host --desired-capacity 1 ;;
  off) V=0; aws "${A[@]}" autoscaling resume-processes --auto-scaling-group-name agentcraft-host --scaling-processes ScheduledActions ;;
  *) echo "usage: $0 on|off"; exit 1 ;;
esac
aws "${A[@]}" ssm put-parameter --name /agentcraft/ignore-season --value "$V" --type String --overwrite >/dev/null
scripts/host-run.sh "cd /opt/agentcraft/infra/docker && sed -i '/^IGNORE_SEASON=/d' .env && echo IGNORE_SEASON=$V >> .env && docker compose up -d >/dev/null 2>&1 && echo applied" 2>/dev/null || echo "(host not running; applies at next boot)"
echo "always-on: $1${V:+ (IGNORE_SEASON=$V)}"
[ "$1" = off ] && echo "The host now follows the 17:45-00:50 UK schedule again (it will scale in at the next 00:50)."
