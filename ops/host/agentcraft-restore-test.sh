#!/usr/bin/env bash
# Restore test: pull the latest backup from S3, extract it to a scratch dir, boot a throwaway
# Paper server on it (internal only, small heap) and confirm the world loads. Leaves the live world alone.
set -euo pipefail
: "${BUCKET:?}"
KEY=$(aws s3 ls "s3://$BUCKET/backups/" | sort | tail -1 | awk '{print $4}')
WORK=$(mktemp -d /data/restore-test.XXXX)
trap 'docker rm -f agentcraft-restore-test >/dev/null 2>&1; rm -rf "$WORK"' EXIT
aws s3 cp --only-show-errors "s3://$BUCKET/backups/$KEY" "$WORK/b.tar.zst"
tar --zstd -xf "$WORK/b.tar.zst" -C "$WORK"
test -f "$WORK/minecraft/world/level.dat" || { echo "RESTORE FAIL: no level.dat in $KEY"; exit 1; }
cp /data/minecraft/paper.jar "$WORK/minecraft/" && cp -r /data/minecraft/cache "$WORK/minecraft/"
chown -R 1000:1000 "$WORK/minecraft"
docker run -d --name agentcraft-restore-test --network none -e EULA=TRUE -e TYPE=CUSTOM -e CUSTOM_SERVER=/data/paper.jar \
  -e ONLINE_MODE=FALSE -e MEMORY=1G -v "$WORK/minecraft:/data" mirror.gcr.io/itzg/minecraft-server:2026.9.2-java21 >/dev/null
for _ in $(seq 1 60); do docker logs agentcraft-restore-test 2>&1 | grep -q 'Done (' && break; sleep 5; done
if docker logs agentcraft-restore-test 2>&1 | grep -q 'Done ('; then
  echo "RESTORE OK: $KEY boots ($(docker logs agentcraft-restore-test 2>&1 | grep -o 'Done ([0-9.]*s)'))"
else
  echo "RESTORE FAIL: server did not start"; docker logs --tail 20 agentcraft-restore-test; exit 1
fi
