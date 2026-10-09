#!/usr/bin/env bash
# One-time bootstrap for the dedicated AgentCraft AWS account.
#
# Run in AWS CloudShell (region eu-west-1) while signed in as the account root
# user or an administrator of the NEW, standalone AgentCraft account:
#
#   git clone --depth 1 -b claude/agentcraft-minecraft-discord-il0zxj https://github.com/fisoluwajana/agentcraft.git
#   bash agentcraft/infra/aws/bootstrap/bootstrap-iam.sh
#
# What it does (idempotent; safe to re-run):
#   1. Refuses to run if the account belongs to an AWS Organization (joining one forfeits Free Tier credits).
#   2. Creates/updates three managed policies: agentcraft-boundary, agentcraft-deployer, agentcraft-deployer-guardrails.
#   3. Creates IAM user agentcraft-deployer (no console access) and attaches the deployer + guardrail policies.
#   4. Turns on account-wide S3 Block Public Access and default EBS encryption in eu-west-1.
#   5. Creates ONE access key for agentcraft-deployer and prints it once (pass --rotate to replace an existing key).
set -euo pipefail

REGION="eu-west-1"
USER_NAME="agentcraft-deployer"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROTATE=false
[[ "${1:-}" == "--rotate" ]] && ROTATE=true

export AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "==> Account ${ACCOUNT_ID}, region ${REGION}"

if aws organizations describe-organization >/dev/null 2>&1; then
  echo "!! This account is part of an AWS Organization. Joining one forfeits Free Tier credits. Aborting." >&2
  exit 1
fi

render() { sed "s/__ACCOUNT_ID__/${ACCOUNT_ID}/g" "${DIR}/policies/$1.json"; }

upsert_policy() {
  local name="$1" arn="arn:aws:iam::${ACCOUNT_ID}:policy/$1" doc
  doc="$(render "$name")"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    # IAM keeps at most 5 versions; drop the oldest non-default one before adding a new version.
    local versions
    # shellcheck disable=SC2016  # backticks are JMESPath literals, not shell
    versions="$(aws iam list-policy-versions --policy-arn "$arn" --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)"
    if [[ "$(wc -w <<<"$versions")" -ge 4 ]]; then
      aws iam delete-policy-version --policy-arn "$arn" --version-id "$(tr '\t' '\n' <<<"$versions" | sort -V | head -1)"
    fi
    aws iam create-policy-version --policy-arn "$arn" --policy-document "$doc" --set-as-default >/dev/null
    echo "    updated policy ${name}"
  else
    aws iam create-policy --policy-name "$name" --policy-document "$doc" \
      --description "AgentCraft bootstrap policy" --tags Key=project,Value=agentcraft >/dev/null
    echo "    created policy ${name}"
  fi
}

echo "==> Policies"
upsert_policy agentcraft-boundary
upsert_policy agentcraft-deployer
upsert_policy agentcraft-deployer-guardrails

echo "==> IAM user ${USER_NAME}"
if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws iam create-user --user-name "$USER_NAME" --tags Key=project,Value=agentcraft >/dev/null
  echo "    created user (programmatic access only)"
fi
for p in agentcraft-deployer agentcraft-deployer-guardrails; do
  aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${p}"
done
echo "    attached agentcraft-deployer + agentcraft-deployer-guardrails"

echo "==> Account hardening"
aws s3control put-public-access-block --account-id "$ACCOUNT_ID" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws ec2 enable-ebs-encryption-by-default --region "$REGION" >/dev/null
echo "    S3 Block Public Access on (account-wide); EBS default encryption on (${REGION})"

echo "==> Access key"
existing="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text)"
if [[ -n "$existing" && "$ROTATE" != true ]]; then
  echo "    ${USER_NAME} already has key(s): ${existing}"
  echo "    Re-run with --rotate to delete them and issue a fresh key."
  exit 0
fi
for k in $existing; do aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$k"; echo "    deleted old key $k"; done

read -r KEY_ID KEY_SECRET < <(aws iam create-access-key --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)

cat <<EOF

=====================================================================
 Copy these into your Claude Code cloud environment settings as
 environment variables. Do NOT paste them into the chat.

   AWS_ACCESS_KEY_ID=${KEY_ID}
   AWS_SECRET_ACCESS_KEY=${KEY_SECRET}
   AWS_REGION=${REGION}
   AWS_DEFAULT_REGION=${REGION}

 The secret is shown only once. Run 'clear' after copying.
=====================================================================
EOF
