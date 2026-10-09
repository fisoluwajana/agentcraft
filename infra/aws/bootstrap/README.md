# AWS account bootstrap

One-time setup for the dedicated AgentCraft AWS account, run by the account owner in **AWS CloudShell (eu-west-2)**.

```bash
git clone --depth 1 -b claude/agentcraft-minecraft-discord-il0zxj https://github.com/fisoluwajana/agentcraft.git
less agentcraft/infra/aws/bootstrap/bootstrap-iam.sh          # review first
bash agentcraft/infra/aws/bootstrap/bootstrap-iam.sh          # policies, deployer user, hardening, access key
bash agentcraft/infra/aws/bootstrap/put-discord-secrets.sh    # Discord tokens -> Secrets Manager (hidden input)
```

| Policy | Attached to | Purpose |
|---|---|---|
| `agentcraft-deployer` | IAM user `agentcraft-deployer` | What Terraform and the operator need: EC2/ASG/VPC, `agentcraft-*` S3, secrets, logs, SNS, Lambda and schedules, `/agentcraft/*` SSM parameters, SSM sessions on instances tagged `project=agentcraft`, bounded IAM roles, Bedrock inference, budgets, read-only cost, pricing and Free Tier APIs. |
| `agentcraft-deployer-guardrails` | same user | Explicit denies: outside eu-west-2, non-Graviton or larger than xlarge, any security-group ingress, NAT, RIs, Savings Plans, Marketplace subscriptions, Marketplace-billed models, provisioned throughput, Organizations and account changes, plan upgrade, creating users or keys, editing its own policies or the boundary. |
| `agentcraft-boundary` | every role Terraform creates (enforced) | Runtime ceiling: SSM agent, logs and metrics, attach the world volume, ASG control for the kill switch, Bedrock invoke (never Marketplace), `agentcraft-*` S3 and secrets, SNS publish, cost read. |

Rotate the deployer key: `bash agentcraft/infra/aws/bootstrap/bootstrap-iam.sh --rotate`.
