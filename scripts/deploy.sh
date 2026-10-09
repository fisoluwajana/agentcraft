#!/usr/bin/env bash
# Ship the current commit: tarball -> S3 -> /agentcraft/release, then (if the host is up)
# apply it over SSM. No inbound access and no GitHub credentials on the host.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=eu-north-1 AWS_PAGER=""
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN 2>/dev/null || true
A=(--profile "${AWS_PROFILE_NAME:-agentcraft}" --region eu-north-1)
ACCOUNT=$(aws "${A[@]}" sts get-caller-identity --query Account --output text)
BUCKET="agentcraft-data-$ACCOUNT"
SHA=$(git rev-parse --short=12 HEAD)
[ -z "$(git status --porcelain)" ] || { echo "commit your changes first"; exit 1; }
git archive --format=tar.gz -o "/tmp/agentcraft-$SHA.tar.gz" HEAD
aws "${A[@]}" s3 cp --only-show-errors "/tmp/agentcraft-$SHA.tar.gz" "s3://$BUCKET/releases/$SHA.tar.gz"
aws "${A[@]}" ssm put-parameter --name /agentcraft/release --value "$SHA" --type String --overwrite >/dev/null
echo "release $SHA uploaded"
IDS=$(aws "${A[@]}" ec2 describe-instances --filters Name=tag:project,Values=agentcraft Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$IDS" ]; then
  CMD="set -e; aws s3 cp s3://$BUCKET/releases/$SHA.tar.gz /tmp/r.tgz; cd /opt/agentcraft; cp infra/docker/.env /tmp/.env.keep; find . -mindepth 1 -delete; tar -xzf /tmp/r.tgz; cp /tmp/.env.keep infra/docker/.env; install -m 0755 ops/host/*.sh /usr/local/bin/; server/fetch-paper.sh /data/minecraft; cd infra/docker && docker compose up -d --build --remove-orphans"
  # shellcheck disable=SC2086
  aws "${A[@]}" ssm send-command --instance-ids $IDS --document-name AWS-RunShellScript \
    --parameters "commands=[\"$CMD\"]" --comment "agentcraft deploy $SHA" --query Command.CommandId --output text
  echo "applying on $IDS (check with: aws ssm list-command-invocations --details)"
else
  echo "host is down; it will pick up $SHA at the next scheduled start"
fi
