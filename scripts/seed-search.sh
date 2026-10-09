#!/usr/bin/env bash
# Try Minecraft seeds on the local dev server and print a terrain score for each spawn.
set -euo pipefail
cd "$(dirname "$0")/.."
D=${MC_DEV_DIR:?path to the mc-dev data dir}
for seed in "$@"; do
  docker rm -f mc-seed >/dev/null 2>&1 || true
  docker run -d --name mc-seed -e EULA=TRUE -e TYPE=CUSTOM -e CUSTOM_SERVER=/data/paper.jar -e ONLINE_MODE=FALSE \
    -e LEVEL="seed_$seed" -e SEED="$seed" -e DIFFICULTY=peaceful -e MEMORY=2G -e VIEW_DISTANCE=6 -e SPAWN_PROTECTION=0 \
    -e "JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStore=/certs/cacerts -Djavax.net.ssl.trustStorePassword=changeit" \
    -v /etc/ssl/certs/java/cacerts:/certs/cacerts:ro -p 127.0.0.1:25566:25565 -v "$D:/data" \
    mirror.gcr.io/itzg/minecraft-server:2026.9.2-java21 >/dev/null
  until docker logs mc-seed 2>&1 | grep -q 'Done ('; do sleep 3; done
  printf '%s ' "$seed"; sed 's/25565/25566/' tests/manual/seed-probe.mjs > tests/manual/.seed-probe-tmp.mjs
  timeout 70 node --no-warnings tests/manual/.seed-probe-tmp.mjs | tail -1
done
docker rm -f mc-seed >/dev/null 2>&1; rm -f tests/manual/.seed-probe-tmp.mjs
