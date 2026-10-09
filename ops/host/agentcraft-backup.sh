#!/usr/bin/env bash
# World backup to S3 (runs on the host every 6 h and on drain). Alerts #ops on failure.
set -euo pipefail
: "${BUCKET:?}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/data/backups/world-$TS.tar.zst
cd /opt/agentcraft/infra/docker
rc() { docker compose exec -T minecraft rcon-cli "$@" >/dev/null 2>&1 || true; }
fail() { docker compose exec -T ops node ops/notify.js "💾❌ backup failed: $1" >/dev/null 2>&1 || true; exit 1; }
trap 'fail "line $LINENO"' ERR
rc save-off; rc "save-all flush"; sleep 5
tar --zstd -cf "$OUT" -C /data minecraft/world minecraft/world_nether minecraft/world_the_end state agents 2>/dev/null \
  || tar --zstd -cf "$OUT" -C /data minecraft state agents
rc save-on
aws s3 cp --only-show-errors "$OUT" "s3://$BUCKET/backups/world-$TS.tar.zst"
find /data/backups -name "world-*.tar.zst" -printf "%T@ %p\n" | sort -rn | tail -n +3 | cut -d" " -f2- | xargs -r rm -f   # keep 2 local copies
docker compose exec -T ops node ops/notify.js "💾 backup ok: world-$TS ($(du -h "$OUT" | cut -f1))" >/dev/null 2>&1 || true
echo "backup ok: $OUT"
