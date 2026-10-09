#!/usr/bin/env bash
# Watches for scale-in (ASG lifecycle hook) and Spot interruption notices, then saves the
# world, backs up, stops the stack, unmounts the world volume and lets the instance go.
set -uo pipefail
imds() { local t; t=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60"); curl -sf -H "X-aws-ec2-metadata-token: $t" "http://169.254.169.254/latest/$1"; }
drain() {
  echo "draining: $1"
  cd /opt/agentcraft/infra/docker && docker compose exec -T ops node ops/notify.js "🌙 host shutting down ($1): saving world" >/dev/null 2>&1 || true
  BUCKET="$BUCKET" timeout 600 /usr/local/bin/agentcraft-backup.sh || true
  docker compose stop -t 60 || true
  sync; umount /data || umount -l /data || true
  aws ec2 detach-volume --volume-id "$VOLUME" >/dev/null 2>&1 || true
}
while true; do
  if imds meta-data/spot/instance-action >/dev/null; then drain "spot interruption"; sleep 300; fi
  state=$(imds meta-data/autoscaling/target-lifecycle-state || echo InService)
  if [ "$state" = "Terminated" ]; then
    drain "scheduled scale-in"
    aws autoscaling complete-lifecycle-action --auto-scaling-group-name "$ASG" --lifecycle-hook-name "$HOOK" \
      --instance-id "$INSTANCE" --lifecycle-action-result CONTINUE || true
    sleep 600
  fi
  sleep 5
done
