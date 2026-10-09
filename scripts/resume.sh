#!/usr/bin/env bash
# Undo the kill switch: allow the schedule to wake the host again (and optionally start now).
# Usage: scripts/resume.sh [--now]
set -euo pipefail
export AWS_REGION=eu-north-1 AWS_PAGER=""
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
A=(--profile "${AWS_PROFILE_NAME:-agentcraft}" --region eu-north-1)
ASG=agentcraft-host
aws "${A[@]}" autoscaling update-auto-scaling-group --auto-scaling-group-name "$ASG" --min-size 0 --max-size 1
aws "${A[@]}" autoscaling resume-processes --auto-scaling-group-name "$ASG" --scaling-processes ScheduledActions
[[ "${1:-}" == "--now" ]] && aws "${A[@]}" autoscaling set-desired-capacity --auto-scaling-group-name "$ASG" --desired-capacity 1
echo "resumed: the host follows the season schedule again${1:+ (and is starting now)}"
