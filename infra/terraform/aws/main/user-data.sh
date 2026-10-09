#!/bin/bash
# AgentCraft host bootstrap (Amazon Linux 2023, x86_64). Rendered by Terraform templatefile().
set -euo pipefail
exec > >(tee -a /var/log/agentcraft-boot.log) 2>&1
REGION=${region}
BUCKET=${data_bucket}
ASG=${asg_name}
HOOK=${lifecycle_hook}
export AWS_DEFAULT_REGION=$REGION

imds() { local t; t=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300"); curl -s -H "X-aws-ec2-metadata-token: $t" "http://169.254.169.254/latest/$1"; }
INSTANCE=$(imds meta-data/instance-id)

echo "== packages"
dnf install -y -q docker jq tar gzip zstd
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-x86_64"
echo "7af95166a730b87e172d4fc9aefea8725d3c6c7327d59149267b452114ddb7d4  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
systemctl enable --now docker

echo "== world from S3"
# The host can boot in any AZ, so the world comes from the newest backup. If a previous host is
# still draining (Spot notice or scale-in), wait for it to finish its final backup first.
for i in $(seq 1 40); do
  others=$(aws ec2 describe-instances --filters Name=tag:project,Values=agentcraft Name=instance-state-name,Values=running,stopping,shutting-down \
    --query "Reservations[].Instances[?InstanceId!='$INSTANCE'].InstanceId" --output text)
  [ -z "$others" ] && break
  echo "previous host $others still draining; waiting ($i)"; sleep 15
done
mkdir -p /data
LATEST=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix backups/ --query 'sort_by(Contents[?ends_with(Key, `.tar.zst`)], &LastModified)[-1].Key' --output text)
if [ -n "$LATEST" ] && [ "$LATEST" != "None" ]; then
  echo "restoring $LATEST"
  aws s3 cp --only-show-errors "s3://$BUCKET/$LATEST" /tmp/world.tar.zst
  tar --zstd -xf /tmp/world.tar.zst -C /data && rm -f /tmp/world.tar.zst
else
  echo "no backup found: starting a fresh world"
fi
mkdir -p /data/minecraft /data/state /data/agents /data/backups
chown -R 1000:1000 /data/minecraft /data/state /data/agents

echo "== release"
REL=$(aws ssm get-parameter --name /agentcraft/release --query Parameter.Value --output text)
mkdir -p /opt/agentcraft
if [ "$REL" != "none" ]; then
  aws s3 cp "s3://$BUCKET/releases/$REL.tar.gz" /tmp/release.tgz
  rm -rf /opt/agentcraft/* && tar -xzf /tmp/release.tgz -C /opt/agentcraft
fi

echo "== paper"
[ -x /opt/agentcraft/server/fetch-paper.sh ] && /opt/agentcraft/server/fetch-paper.sh /data/minecraft

echo "== secrets into the compose env (never logged)"
umask 077
RCON=$(aws ssm get-parameter --name /agentcraft/rcon-password --with-decryption --query Parameter.Value --output text)
IGNORE=$(aws ssm get-parameter --name /agentcraft/ignore-season --query Parameter.Value --output text 2>/dev/null || echo 0)
printf 'RCON_PASSWORD=%s\nIGNORE_SEASON=%s\n' "$RCON" "$IGNORE" > /opt/agentcraft/infra/docker/.env 2>/dev/null || true

echo "== helpers"
install -m 0755 /opt/agentcraft/ops/host/*.sh /usr/local/bin/ 2>/dev/null || true
cat > /etc/systemd/system/agentcraft-backup.service <<UNIT
[Unit]
Description=AgentCraft world backup
[Service]
Type=oneshot
Environment=BUCKET=$BUCKET AWS_DEFAULT_REGION=$REGION
ExecStart=/usr/local/bin/agentcraft-backup.sh
UNIT
cat > /etc/systemd/system/agentcraft-backup.timer <<UNIT
[Unit]
Description=AgentCraft backup every 6 hours while the host is up
[Timer]
OnBootSec=6h
OnUnitActiveSec=6h
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/agentcraft-rolling-backup.service <<UNIT
[Unit]
Description=AgentCraft rolling world backup (caps what a Spot reclaim can lose)
[Service]
Type=oneshot
Environment=BUCKET=$BUCKET AWS_DEFAULT_REGION=$REGION PREFIX=backups/rolling/ QUIET=1
ExecStart=/usr/local/bin/agentcraft-backup.sh
UNIT
cat > /etc/systemd/system/agentcraft-rolling-backup.timer <<UNIT
[Unit]
Description=AgentCraft rolling backup every 10 minutes
[Timer]
OnBootSec=10min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/agentcraft-drain.service <<UNIT
[Unit]
Description=AgentCraft: save and back up the world on scale-in or Spot interruption
After=docker.service
[Service]
Environment=BUCKET=$BUCKET AWS_DEFAULT_REGION=$REGION ASG=$ASG HOOK=$HOOK INSTANCE=$INSTANCE
ExecStart=/usr/local/bin/agentcraft-drain.sh
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now agentcraft-backup.timer agentcraft-rolling-backup.timer agentcraft-drain.service

echo "== start"
if [ -f /opt/agentcraft/infra/docker/compose.yml ]; then
  cd /opt/agentcraft/infra/docker && docker compose up -d --build
fi
echo "== boot complete"
