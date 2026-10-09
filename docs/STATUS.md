# Status

Last updated: 2026-10-09

## Where we are
Phase 0.3: waiting on the owner's one-batch answers (AWS bootstrap, network allowlist, Discord bots, budgets, EULA, schedule, alerts).

## Done
- 0.1 Environment checked. Blocked in the build session: discord.com, gateway.discord.gg, cdn.discordapp.com, api/fill/fill-data.papermc.io, piston-meta/piston-data.mojang.com, libraries.minecraft.net, registry.terraform.io (plus Hetzner, Oracle, Tailscale and OpenAI, none of which are needed now). All AWS endpoints, Bedrock included, are reachable.
- 0.2 Hosting chosen: AWS eu-west-1 on a new standalone account (Paid plan), LLMs on credit-eligible Bedrock models. See DECISIONS.md.
- Bootstrap scripts written: `infra/aws/bootstrap/`.

## Next
1. Owner runs `bootstrap-iam.sh` and `put-discord-secrets.sh` in CloudShell, then adds the AWS env vars and the network allowlist to the cloud environment.
2. Verify the credentials (`aws sts get-caller-identity`) and validate the policies with Access Analyzer.
3. Prove credit eligibility empirically: one small call per candidate Bedrock model, then check Cost Explorer for Credit line items 24 h later.
4. Phase 1 build.

## Resuming in a new session
Read this file and DECISIONS.md, then check `env | grep ^AWS_` and `aws sts get-caller-identity`.
