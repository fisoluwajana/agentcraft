#!/usr/bin/env bash
# Fetch the pinned Paper build (and the Mojang server jar it patches) with checksum checks.
# Usage: server/fetch-paper.sh <minecraft data dir>
set -euo pipefail
DIR="${1:?data dir}"
PAPER_VERSION=1.21.11
PAPER_BUILD=132
PAPER_SHA256=5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba
MOJANG_SHA1=64bb6d763bed0a9f1d632ec347938594144943ed
UA="AgentCraft/0.1 (github.com/fisoluwajana/agentcraft)"
mkdir -p "$DIR/cache"
if ! echo "$PAPER_SHA256  $DIR/paper.jar" | sha256sum -c - >/dev/null 2>&1; then
  curl -fsSL -A "$UA" -o "$DIR/paper.jar" \
    "https://fill-data.papermc.io/v1/objects/$PAPER_SHA256/paper-$PAPER_VERSION-$PAPER_BUILD.jar"
  echo "$PAPER_SHA256  $DIR/paper.jar" | sha256sum -c -
fi
if ! echo "$MOJANG_SHA1  $DIR/cache/mojang_$PAPER_VERSION.jar" | sha1sum -c - >/dev/null 2>&1; then
  curl -fsSL -A "$UA" -o "$DIR/cache/mojang_$PAPER_VERSION.jar" \
    "https://piston-data.mojang.com/v1/objects/$MOJANG_SHA1/server.jar"
  echo "$MOJANG_SHA1  $DIR/cache/mojang_$PAPER_VERSION.jar" | sha1sum -c -
fi
chown -R 1000:1000 "$DIR" 2>/dev/null || true
echo "paper $PAPER_VERSION-$PAPER_BUILD ready in $DIR"
