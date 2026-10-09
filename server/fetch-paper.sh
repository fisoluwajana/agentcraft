#!/usr/bin/env bash
# Fetch the pinned Paper build (and the Mojang server jar it patches) with checksum checks.
# Usage: server/fetch-paper.sh <minecraft data dir>
set -euo pipefail
DIR="${1:?data dir}"
PAPER_VERSION=1.21.4
PAPER_BUILD=232
PAPER_SHA256=5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc
MOJANG_SHA1=4707d00eb834b446575d89a61a11b5d548d8c001
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
