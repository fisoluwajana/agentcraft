# Decisions

Every decision made on the owner's behalf, with a one-line reason. Newest last within each section.

## Hosting and account

| # | Decision | Reason |
|---|---|---|
| H1 | Host on AWS eu-north-1 (Stockholm), not Oracle, Hetzner or self-hosted | Only option fully operable from the build session today (Hetzner, Oracle and Tailscale endpoints are blocked); native budgets and SSM. Oracle cut Always Free A1 to 2 OCPU/12 GB in Aug 2026; Hetzner CAX has been out of stock in all EU locations since Sep 2026. |
| H2 | Account is a "new AWS experience" **project** (409178193669): Free plan, $100 credit (+$100 from 5 activities), expires 2027-04-09, inside an AWS-managed Organization with managed SCPs/RCPs | Owner's choice; the managed Organization does not forfeit credits for project accounts. Upgrading to Paid before expiry is the owner's call. |
| H2a | Region is **eu-north-1 (Stockholm)** | Project accounts are locked to one Region; all candidate Bedrock models run in-region there, so no cross-Region inference is needed. |
| H3 | Graviton Spot in a 0–1 Auto Scaling group with a scheduled scale-out/in, world on a separate persistent gp3 volume attached at boot | Cuts compute to the active hours (~8 h/day) and makes Spot interruptions recoverable without data loss. |
| H4 | Terraform S3 backend with native lockfile (`use_lockfile`), no DynamoDB table | Supported since Terraform 1.10; one fewer service and one fewer IAM grant. |
| H5 | Deploy by uploading a release tarball to S3 and applying it over SSM Run Command; images build natively on the arm64 host | No GitHub credentials or container registry needed on the host; no inbound ports. |
| H6 | Base images from `mirror.gcr.io` / `public.ecr.aws` | Docker Hub rate-limits (429) the build session's shared egress IP. |

## IAM

| # | Decision | Reason |
|---|---|---|
| I1 | Deployer gets `ec2:*` and `autoscaling:*` in the dedicated account, constrained by explicit guardrail denies, instead of tag-conditioned EC2 statements | Tag-scoped RunInstances policies are brittle and every fix would need the owner to edit IAM by hand; the dedicated account plus the denies is the real boundary. |
| I2 | Guardrails: Stockholm only (except global services and Bedrock), Graviton ≤ xlarge only, no security-group ingress at all, no NAT, Reserved Instances, Savings Plans, provisioned throughput or Marketplace subscriptions | Makes "human-proof" and "cheap" structural, not just conventions. |
| I3 | Every role the deployer creates must carry the `agentcraft-boundary` permissions boundary, which the deployer cannot edit | Prefix-scoped IAM alone allows privilege escalation; the boundary caps whatever roles Terraform creates. |
| I4 | Build session authenticates with `aws login` (profile `agentcraft`, 12 h sessions renewable for 90 days); the IAM-user bootstrap is superseded by a bounded deployer role | Project accounts manage human access themselves (team members, not IAM users); short-lived credentials beat a long-lived key. |

## LLM

| # | Decision | Reason |
|---|---|---|
| L1 | Owner choice: only models billed as "Amazon Bedrock" (sold by AWS), so Free Tier credits pay for them | Per the AWS price list, Claude, Cohere, TwelveLabs and OpenAI GPT-6 on Bedrock are sold through AWS Marketplace ("Bedrock Edition"), which promotional credits exclude. |
| L2 | Marketplace-billed models are denied in IAM (deployer guardrails and runtime boundary) | Guarantees no model call can bill outside the credits by accident. |
| L3 | Candidate models (London, $/1M tokens in/out): gpt-oss-120b 0.23/0.93, Qwen3 235B 2507 0.34/0.685, Mistral Large 3 0.775/2.325, Kimi K2.5 0.93/4.65, gpt-oss-20b 0.05/0.47, Nova Micro 0.049/0.196, Qwen3 Coder 480B 0.35/2.79. Final picks come from a benchmark. | Prices from the AWS Price List API (effective 2026-10-01); quality must be measured, not assumed. |
| L4 | Different model family per agent | Voice variety for free, replacing the brief's "second provider" idea. |
| L5 | "Flex" service tier (~50% off) for non-real-time work (Chronicle, recaps, summaries, relationship updates) instead of the Batch API | Same discount without Bedrock batch's minimum job size and S3 plumbing. |
| L7 | All inference goes through the **bedrock-mantle** endpoint (OpenAI-compatible `/v1/chat/completions`, SigV4 service `bedrock-mantle`), not `bedrock-runtime` | This project's applied `bedrock-runtime` quotas are 0 and non-adjustable for every model, while mantle has separate quotas and works (verified 2026-10-09: gpt-oss-120b, Kimi K2.5, DeepSeek V3.2, GLM-5, Qwen3 32B, Qwen3 Coder 480B). Opening a support case via API needs a paid support plan. |
| L6 | Short-context discipline is mandatory | Most AWS-sold models have no prompt caching on Bedrock, so every input token is billed at full price. |

## Discord

| # | Decision | Reason |
|---|---|---|
| D1 | One system bot (Administrator) creates and runs the server; agents post through per-channel webhooks with their own name and avatar. Dedicated per-agent bot apps are an optional later upgrade | Discord's API can't create applications or bots, and bots can't create servers, so the owner makes the server and one app; webhooks need no extra owner setup. Cost: agents can't add reactions or show typing until they have their own bots. |
| D2 | Spectators can't post in agent channels, and agent bots are denied View Channel on #spectator-chat | Isolation enforced by Discord permissions, not by code. |

## Repository

| # | Decision | Reason |
|---|---|---|
| R1 | Repo is public, so agents' private agendas live in S3, not git | Spectators could otherwise read the spoilers. |

## Owner answers (2026-10-09)

| # | Decision | Reason |
|---|---|---|
| O1 | Budget ceilings: hosting £15 (~$20), LLM £60 (~$80) a month | Owner accepted the defaults. |
| O2 | Credits-only: stop everything when credits run out, never spend real money | Owner instruction. Enforced by a credit-balance watchdog plus AWS Budgets; the project stays on the Free plan. |
| O3 | Minecraft EULA accepted by the owner on 2026-10-09 | Recorded so `eula=true` is backed by explicit consent. |
| O4 | Season: 3 agents, daily 18:00–00:00 Europe/London (6 h) | Cost scales with hours, not time of day (Spot and Bedrock prices don't follow a daily cycle), so the cheapest schedule is the shortest window that still lands in UK evening viewing; 6 h is the brief's lower bound. |
| O5 | Alerts go to Discord #ops only; no email | Owner instruction. |
| O6 | No local GPU; all inference on Bedrock | Owner has none. |
| O7 | Work only on branch `claude/agentcraft-minecraft-discord-il0zxj`; no PRs | Owner instruction. |
