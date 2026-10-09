# HANDOFF: read this first

This file holds the full context needed to pick the project up in a fresh session, with any agent and no chat history.
It is updated with every commit. Companion files: `docs/STATUS.md` (live progress and blockers), `DECISIONS.md` (every decision with its reason), `CLAUDE.md` (agent instructions plus the AWS Agent Toolkit rules).

## 1. What we're building
**AgentCraft** is a Minecraft (Paper) server where only AI agents play. They explore, gather, build a settlement and complete group projects, and they coordinate in a Discord server. Their messages should read like real people, not bot status updates. Humans can only watch.
The owner's full original brief is reproduced in section 9. Treat it as the spec.

## 2. Owner and working rules
- Owner: experienced cloud engineer (AWS, Terraform, IAM). Wants a hands-off build: make decisions, log them in `DECISIONS.md`, and only stop for:
  (a) hosting choice and Phase 0 checklist (done), (b) first infra apply, (c) choosing the scaling configuration after the metered test, (d) anything destructive or irreversible, (e) anything over budget, (f) credentials only the owner can provide.
- Communication style the owner asked for: tag claims [Certain]/[Likely]/[Guessing], uncomfortable truth first, no warm-up, no filler phrases, hold positions unless given new reasoning. Friendly tone.
- Git: work **only** on branch `claude/agentcraft-minecraft-discord-il0zxj`; no PRs. Never commit secrets.
- **Credits only: never spend real money.** Stop all activity before the AWS credits run out.

## 3. Accounts, access, secrets (no secret values here)
| Thing | Value |
|---|---|
| AWS | "New AWS experience" **project**, account `409178193669`, **Free plan**, $100 credit (+$100 available from 5 Free Tier activities), plan expires **2027-04-09**. Inside an AWS-managed Organization with managed SCPs/RCPs (e.g. Redshift denied). |
| AWS Region | **eu-north-1 (Stockholm)** only. Projects can't create Regional resources elsewhere. |
| AWS auth (build session) | `aws login --remote --region eu-north-1 --profile agentcraft` (browser sign-in; 12 h sessions renewable for 90 days). Role: `AccountFullAccessRole`. Credentials live in the session container's `~/.aws`, so a new container needs a new login. |
| AWS MCP | Agent Toolkit for AWS installed in Claude Code (`aws configure agent-toolkit`), with the `aws-mcp` server using `AWS_MCP_PROXY_PROFILES=agentcraft`. |
| Bedrock | **Use the `bedrock-mantle` endpoint** (`https://bedrock-mantle.eu-north-1.api.aws/v1/chat/completions`, OpenAI-compatible, SigV4 service name `bedrock-mantle`). `bedrock-runtime` quotas are 0 and non-adjustable on this project. Only models sold by AWS (credit-eligible). Never Anthropic/Cohere/TwelveLabs/GPT-6 (AWS Marketplace, not covered by credits). |
| Discord | Server "agentcraft", guild `1558075925252542484`. System bot app `1558073838993154089` (Administrator, private, Server Members and Message Content intents on). Spectator invite: https://discord.gg/pHYaWcVD2A |
| Secret `agentcraft/discord` (Secrets Manager, eu-north-1) | keys: `guild_id`, `system_bot_token`, `channel_ids{}`, `webhooks{}` (per channel; credentials), `spectator_role_id`, `invite_code` |
| GitHub | `fisoluwajana/agentcraft` (public repo). Claude GitHub App installed. |

## 4. Owner answers (Phase 0.3)
Budgets £15 hosting / £60 LLM per month (~$20 / ~$80) · stop everything when credits run out · Minecraft EULA accepted 2026-10-09 · schedule chosen by cost: daily 18:00–00:00 Europe/London, 3 agents · alerts to Discord #ops only, no email · no local GPU · branch only, no PRs.

## 5. Architecture (current plan; see DECISIONS.md for reasons)
- **Host:** one m7i-flex.large Spot instance (x86; Free plan only allows Free Tier eligible types) in a 0–1 Auto Scaling group, scheduled to run only around the season (~17:45–00:45 UK). **Multi-AZ (P14):** the ASG spans eu-north-1a/b/c and the world lives on the root disk, restored at boot from the newest S3 backup (`backups/` or `backups/rolling/`); a new host waits for a draining one's final backup. The old zonal EBS world volume was deleted on 2026-10-09 at the owner's request; S3 backups are the only copies of the world. No inbound rules at all; admin via SSM. Backups to S3 every 6 h (14-day retention) and every 10 min (rolling, 2-day retention), plus one on every drain. Terraform state in S3 with native lockfile.
- **Containers (docker compose):** `minecraft` (itzg/minecraft-server, Paper 1.21.4 (seed 8675309), offline mode, whitelist, RCON on the internal network only, no published ports) · `agent-<name>` × 3 (same Node image) · `ops` (watchdog, narrator, digest, budget checks).
- **Agents:** custom Mineflayer framework (not Mindcraft). Deterministic skills do the work; the LLM is called only on events (chat addressed to the agent, goal finished or failed, danger, discovery, idle) and returns action + Discord message(s) in one JSON response. Routines are saved as JSON sequences of existing skills (no LLM-written code is executed).
- **Discord:** source of truth for chat is the shared SQLite `chat` table; Discord is the display. Agents post via per-channel webhooks with their own name and avatar; the system bot (REST only) adds reactions, threads and #ops alerts. Nothing reads Discord at runtime, so #spectator-chat can't influence agents.
- **Shared state:** SQLite (`node:sqlite`, WAL) at `/data/state/agentcraft.db`: chat, task board, resource ledger, POIs, LLM usage and cost, agent status, votes, events.
  The host has no `sqlite3` binary; query from the ops container, e.g. `scripts/host-run.sh 'cd /opt/agentcraft/infra/docker && docker compose exec -T ops node -e "const {DatabaseSync}=require(\"node:sqlite\");console.log(new DatabaseSync(\"/data/state/agentcraft.db\").prepare(\"SELECT channel,COUNT(*) n FROM chat GROUP BY channel\").all())"'`.
- **Cost controls:** per-agent daily token budget (sleeps early, in character), global monthly LLM ceiling, credit-balance watchdog (Lambda, hourly) that scales the ASG to 0 and posts to #ops, AWS Budgets at 50/80/100 %.
- **Models (mantle, eu-north-1, $/1M in/out):** gpt-oss-120b 0.15/0.60, Qwen3 235B 2507 0.22/0.88, GLM-4.7 Flash 0.08/0.48, Mistral Large 3 0.60/1.80, Kimi K2.5 0.72/3.60. "flex" tier ≈ 50 % off for non-real-time work. Final per-role picks come from a benchmark.

## 5b. Current operating mode
Schedule: evenings only, 18:00-00:00 UK (O9). Always-on for testing: `scripts/always-on.sh on|off` (see `docs/STATUS.md`).

## 6. Repo map
| Path | What |
|---|---|
| `infra/aws/bootstrap/` | Original IAM bootstrap (deployer user, guardrails, boundary). Largely superseded by the `aws login` flow; policies are reused for runtime roles. |
| `infra/terraform/` | Terraform (in progress) |
| `infra/docker/` | docker compose (in progress) |
| `discord/setup/setup_server.py` | Idempotent server setup (roles, channels, permissions, webhooks, invite). Already run. |
| `agents/` | Agent runtime, shared lib, personas, skills (in progress) |
| `ops/` | Watchdog, kill switch, digest, backups (in progress) |
| `server/` | Minecraft server config (in progress) |

## 7. How to resume
1. Read this file, `docs/STATUS.md`, `DECISIONS.md`.
2. Sign in to AWS: `aws login --remote --region eu-north-1 --profile agentcraft` (owner completes the browser step and pastes the code).
3. Check credit and plan: `aws freetier get-account-plan-state --region us-east-1 --profile agentcraft`.
4. `npm install` (Node ≥ 22.13). Docker: start `dockerd` if needed; pull images from `mirror.gcr.io` (Docker Hub rate-limits shared egress).
5. Continue from the "Next" list in `docs/STATUS.md`.

## 8. Gotchas learned the hard way
- `pkill -f <pattern>` inside a Bash tool call can match its own shell and kill the command (exit 144). Use `pgrep` + `kill <pid>`.
- Bedrock `bedrock-runtime` quotas are 0 here; always use mantle. Mantle model IDs differ (e.g. `qwen.qwen3-235b-a22b-2507`, `openai.gpt-oss-120b`).
- Free-plan SCPs deny some services (Redshift, Organizations, etc.); console wizards may show harmless errors.
- PaperMC API v2 is gone (410); use `fill.papermc.io/v3`.
- The Docker daemon in the build container sometimes stops; restart with `dockerd &`.
- The build container has **invalid AWS_ACCESS_KEY_ID/SECRET env vars injected by the environment** (not set by the owner). For local Node runs: `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; eval "$(aws configure export-credentials --profile agentcraft --format env)"`. The JS SDK can't refresh `aws login` sessions itself. Node's fetch also needs `NODE_USE_ENV_PROXY=1` in the build container.
- mantle's `response_format: json_object` makes gpt-oss emit garbage; JSON mode is off unless a model sets `jsonMode: true` in config. The output schema in `agents/src/brain.js` must contain no `//` comments (models copy them).
- Local dev server: Paper container `mc-dev` needs the proxy-aware Java truststore mounted and the Paper/Mojang jars pre-downloaded (PaperMC and Mojang return 403 to Java's downloader through the build proxy). See `server/fetch-paper.sh`.
- Mineflayer pathfinder must have `searchRadius`/`thinkTimeout` set (see `setupMovements`); an unbounded search used 8.7 GB once. Agents run with `--max-old-space-size=448` and a 700 MB container limit.
- Plans must never run concurrently (`replacePlan` pre-empts); skills are capped at 180 s each.
- On mantle, Mistral Large 3 and MiniMax M2.5 hung (>90 s, repeatedly) on 2026-10-09; gpt-oss-120b, Qwen3 235B, GLM-4.7 Flash, Kimi K2.5 respond in 1–26 s.

## 9. Original brief (owner's spec, verbatim summary of requirements)
- Agents only; humans read Discord but can't post in agent channels; #spectator-chat for humans, never read by agents.
- Channels: #general, #off-topic, #builds, #town-hall, #the-chronicle, #ops (private), #spectator-chat. Spectator read-only role.
- Personas: distinct names, personality, quirks, values, typing style, catchphrases, banned phrases ("Great work team!", "Absolutely", "Let's collaborate"), role, private agenda. Varied message lengths, splits, replies, threads, reactions, silence, realistic gaps. Throttle agents that chat more than they play. PG content.
- Narrator "The Chronicler": daily story recap after active hours (cheap/discounted path), weekly season recap.
- Memory per agent: episodic log summarised into notes, personal goals, RELATIONSHIPS (opinions, grudges, debts, jokes). Shared: task board, resource ledger, POI map.
- World goals: base, food, shelter → village → trade and specialisation → big group project voted in #town-hall. Build in scarcity and competing goals.
- LLM cost controls: event-driven not polling; code-first skills reused; model tiering; prompt caching where available; discounted batch/flex for non-real-time; short context; one call for action + voice; cap chatter; active-hours seasons; start with 3 agents.
- Reliability: watchdog (stuck, death loops, token spikes; recover by retry → teleport to base via RCON → restart), per-agent daily token budget, global LLM spend tracker (pause at 100 %), kill switch (one command, documented at top of README), #ops alerts (crashes, budgets, failed backup, agent stuck > 30 min), weekly #ops digest with spend per agent/call type/day, top 3 cost drivers with suggestions.
- Build order: provision (show plan + cost, wait for "go" before first apply) → server + verified backups with a test restore → 30-min 1-agent smoke test → 2-h 3-agent metered soak test with persona tuning → projected monthly cost table for configurations (owner picks) → verify narrator, watchdog, digest, budget pause, kill switch by triggering each → go live.
- Deliverables: `/infra` (Terraform + compose), `/server`, `/agents` (+ `/agents/personas`, skill library), `/discord` (bot, narrator), `/ops` (watchdog, budget, kill switch, digest), `README.md` (kill switch at top, architecture, add an agent, change active hours, cost profile), `RUNBOOK.md`, `DECISIONS.md`.
- Final report to owner: spectator invite link, kill switch command, measured monthly cost estimate, one-paragraph summary.
