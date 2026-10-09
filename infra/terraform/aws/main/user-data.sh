#!/bin/bash
# AgentCraft host bootstrap (Amazon Linux 2023, arm64). Rendered by Terraform templatefile().
set -euo pipefail
exec > >(tee -a /var/log/agentcraft-boot.log) 2>&1
REGION=${region}
VOLUME=${world_volume}
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
  "https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-aarch64"
echo "49082844b87f03cdcd5f5bbef1ba8c9c897b7a2dfb80cea18d61ec8ca6117e0c  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
systemctl enable --now docker

echo "== world volume $VOLUME"
for i in $(seq 1 60); do
  state=$(aws ec2 describe-volumes --volume-ids "$VOLUME" --query 'Volumes[0].State' --output text)
  [ "$state" = "available" ] && break
  echo "volume is $state; waiting for the previous host to release it ($i)"; sleep 10
done
aws ec2 attach-volume --volume-id "$VOLUME" --instance-id "$INSTANCE" --device /dev/sdf >/dev/null
DEV=""
for i in $(seq 1 60); do
  DEV=$(lsblk -dpno NAME,SERIAL | awk -v s="$${VOLUME/-/}" '$2==s{print $1}')
  [ -n "$DEV" ] && break; sleep 2
done
[ -n "$DEV" ] || { echo "world volume never appeared"; exit 1; }
blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -L agentcraft-world "$DEV"
mkdir -p /data && mount "$DEV" /data
mkdir -p /data/minecraft /data/state /data/agents /data/backups
chown -R 1000:1000 /data/minecraft
chown -R 1000:1000 /data/state /data/agents

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
printf 'RCON_PASSWORD=%s\n' "$RCON" > /opt/agentcraft/infra/docker/.env 2>/dev/null || true

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
cat > /etc/systemd/system/agentcraft-drain.service <<UNIT
[Unit]
Description=AgentCraft: save, back up and release the world volume on scale-in or Spot interruption
After=docker.service
[Service]
Environment=BUCKET=$BUCKET AWS_DEFAULT_REGION=$REGION ASG=$ASG HOOK=$HOOK INSTANCE=$INSTANCE VOLUME=$VOLUME
ExecStart=/usr/local/bin/agentcraft-drain.sh
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now agentcraft-backup.timer agentcraft-drain.service

echo "== start"
if [ -f /opt/agentcraft/infra/docker/compose.yml ]; then
  cd /opt/agentcraft/infra/docker && docker compose up -d --build
fi
echo "== boot complete"
