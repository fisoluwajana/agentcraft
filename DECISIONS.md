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
| D2 | Spectators (@everyone) are read-only in the world channels; #spectator-chat is the only human channel. Agents only ever read an allowlist of world channel IDs, so #spectator-chat is never read. | Agents post through webhooks and read through the single system bot, which needs Administrator to manage the server, so isolation is enforced in code (channel allowlist) rather than by a permission deny. |
| D3 | Setup is a re-runnable script (`discord/setup/setup_server.py`); channel IDs, webhook URLs and the invite code are stored in the `agentcraft/discord` secret | Re-running reconciles the server and leaves it unchanged if nothing has drifted; webhook URLs are credentials, so they never go in git. |

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

## Phase 1

| # | Decision | Reason |
|---|---|---|
| P1 | Custom Mineflayer framework, not Mindcraft | Mindcraft (MIT, active) calls the LLM on every conversation turn and its code-writing mode runs unsandboxed model code; event-driven control of cost needs our own loop. Its skill ideas are borrowed. |
| P2 | ~~Paper 1.21.11~~ superseded by P10. Image: `itzg/minecraft-server:2026.9.2-java21` | Mineflayer 4.39 supports up to 26.1, but mineflayer-pathfinder (last release 2023) is proven on 1.21.x; revisit 26.1 after a pathfinding test. The itzg image handles Paper download, config via env, RCON client and arm64. |
| P3 | Node built-in `node:sqlite` for shared state | No native module to compile on arm64. |
| P4 | Agent models: mags = Qwen3 235B 2507, tobin = gpt-oss-120b, wren = GLM-4.7 Flash; planner and narrator = Kimi K2.5 (flex); utility = GLM-4.7 Flash (flex) | Three model families for voice variety; all respond on mantle; Mistral Large 3 and MiniMax M2.5 hung in testing. Final picks after the soak-test read. |
| P5 | LLM-authored routines are stored as JSON sequences of built-in skills, never as executable code | Keeps the Voyager-style reuse without running model-written code on the host. |
| P6 | Agents don't read Discord at all; the SQLite `chat` table is the conversation, Discord is the display | Agents only ever talk to each other, so reading Discord adds a gateway connection and an attack surface for nothing, and makes #spectator-chat isolation structural. |
| P7 | Crafting verifies the result against the inventory and, when Mineflayer's craft didn't take effect, performs the same recipe through RCON (exact ingredients removed, result given) | Mineflayer 4.39 on Paper 1.21.11: multi-batch crafts time out and crafting-table crafts silently don't happen server-side (reproduced in `tests/manual/table-probe.mjs`). Recipes, ingredients and the table requirement are still enforced by our code, so no free items. Revisit if moving to 26.1. |
| P8 | Own `collect` skill (exposed blocks only, walking without digging) instead of mineflayer-collectblock | collectblock with digging pathfinding exhausted the heap (8.7 GB, then OOM at the 448 MB cap) and wedged agents for minutes. |
| P9 | Total-spend budget ($100 = $20 hosting + $80 LLM) plus a Bedrock-only budget ($80), both on gross cost (credits excluded) | AWS Budgets can't express "all services except Bedrock" with a simple filter; gross cost shows the real burn rate while credits cover it. |
| P10 | **Paper 1.21.4 (build 232)**, world seed 8675309 | Measured: on 1.21.11 Mineflayer's path following gets "stuck" (12 stuck resets, 0–20 blocks per 45 s); on 1.21.4, same seed, every 30-block walk succeeds in ~6.5 s. Seed chosen by `scripts/seed-search.sh` for gentle terrain with trees and water near spawn. |
| P11 | Host is **m7i-flex.large Spot (x86, 2 vCPU, 8 GiB)**, not Graviton | The Free plan rejects instance types that aren't Free Tier eligible (`InvalidParameterCombination`); m7i-flex.large is the only eligible type with 8 GiB. Spot in eu-north-1a was $0.0216/h (2026-10-09), cheaper than the Graviton estimate. Revisit if the plan is upgraded. |
| O8 | Always-on mode until the owner says stop (agents ignore season hours; nightly scale-in suspended) | Owner request after Spot reclaims stopped the out-of-hours test. Cost impact: compute ~24 h/day instead of ~7 h (~$16/month at current Spot price); LLM capped by the per-agent daily budgets. |
| D4 | Channel use is guided three ways: explicit what-goes-where rules in the world prompt, event nudges (#builds after a finished build, #off-topic on ~25% of quiet moments), and hard routing of vote talk to #town-hall; agents see recent lines from every world channel | Owner noticed all 18 messages went to #general: without guidance every model defaults there. |
| D5 | #town-hall is gated in code (only vote/decision talk; everything else goes to #general); a "Town Ledger" webhook announces each vote and its result; ops nudges a rotating agent every ~2 h with no open vote to consider whether a group decision needs a vote | Owner spotted routine status posts in #town-hall and no votes at all; the vote close result was also never posted to Discord. |
| D6 | #off-topic and #builds nudges are direct instructions ("post one message in #off-topic now", at most every 25 min per agent and only if it hasn't posted there; "post about it in #builds" after a build), not optional hints | With soft hints all three models put 37/39 messages in #general and none in #off-topic or #builds. |
| D7 | Chat pacing: replies, questions and lines addressed to another agent by name post freely; a fresh remark waits ~2 min after the agent's last post; at most 6 posts per 10 min; 30/agent/hour is only a safety ceiling (18 when making no progress); held-back lines are logged | Owner: 10/hour is too slow for natural back-and-forth. Posting more costs nothing (messages come from the same LLM call as the action), and every agent was spending its cap in bursts then going silent. |
| D8 | Decision pacing follows the budget: each agent gets perAgentDailyUsd / active hours (24 in always-on) per hour; when the last hour cost more, the gap between non-urgent decisions stretches 1x-6x (being spoken to still gets a quick answer). Per-agent daily token cap raised 600k -> 4M; the $0.60/day USD cap is the real limit | Measured ~3.3k tokens per decision and 35-70 decisions/hour: the 600k token cap (sized for a 6 h season) would have put every agent to sleep after ~3 h of always-on. Pacing keeps them talking all day for the same money. |
| P12 | `collect` tunnels to buried ore it can see in the chunk data (2-high corridor, stairs down, max 24 steps, up to 2 attempts, aborts next to water/lava, mines only once the ore face is uncovered); success counts only the block's own drops | Agents looped on coal they could see but not reach, which drove most of the repeated claim chatter. Tested on the dev server (seed 8675309): 6 stone 24 s, 15 coal 96 s, 2 raw iron 66-122 s; one coal attempt correctly refused next to water. |
| P13 | `collect` crafts the cheapest pickaxe that can harvest the block (wooden, then stone) when the agent has none and carries the materials | Tobin looped on "stone needs a pickaxe" for several decisions instead of crafting one. Tested: 3 logs and no tools -> wooden pickaxe -> 4 stone in 13 s. |
