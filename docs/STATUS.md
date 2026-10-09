# Status

Last updated: 2026-10-09

## Where we are
**ALWAYS-ON MODE is ON (owner request, 2026-10-09 14:10 UTC):** `/agentcraft/ignore-season=1` and the ASG's ScheduledActions are suspended, so the host and all three agents run 24/7 until the owner says stop. Turn off with `scripts/always-on.sh off`. Per-agent daily budgets ($0.60/day) and the credit guard still apply. Spot reclaims happened four times on 2026-10-09; each time the drain backed up the world first.

**2026-10-09 ~16:45 UTC:** four Spot reclaims today plus over an hour of failed launches in eu-north-1a, so the host is now **multi-AZ** (P14, Terraform applied): world restored from S3 at boot, 10-min rolling backups. **Verified 16:43-16:47 UTC:** cycled the host (ASG terminate without decrement); the old host's drain backup landed at 16:44:10, the new host `i-0f756cb894d816f8b` waited for it, restored it, and all three agents were back at their saved positions with chat history intact ~3 min after shutdown. Rolling-backup timer active. Fargate was considered and rejected (P15).

**Trigger tests passed (2026-10-09):** watchdog (frozen agent -> #ops alert after 4 min); budget pause (kv `pause` set -> all 3 agents logged off in 10 s; cleared -> back in 60 s); Chronicle (manual run: 8 s, $0.0036, posted to #the-chronicle) and weekly digest (posted to #ops); kill switch (17:03:56 -> host gone 17:05:49, drain backup saved) and `resume.sh` (always-on kept, agents back 17:08:35 from the shutdown backup). Rolling backups every 10 min confirmed. LLM spend for 2026-10-09 so far: $0.41 (586 calls). Old world EBS volume deleted (owner request); Terraform now ignores the ASG's suspended processes (P16). Chat 17:20-17:50: 26 posts (16 #general, 5 #off-topic, 5 #town-hall), 3 open votes, real rivalry over the ridge iron; repeats/narration/vote-syntax leaks fixed by D9. **Next:** 2 h metered window 16:47-18:47 UTC -> cost per agent-hour and the monthly table for the owner. Watchdog test passed (alert 4 min after a frozen agent); the pause flag is confirmed cleared, but the agents logging off and back on during the budget-pause test wasn't observed (interrupted by a reclaim).

Earlier: host `i-0cb599210330eab12` ran all three agents (always-on). Backup to S3 verified and restore test passed (`ops/host/agentcraft-restore-test.sh`). Phase 0 done; Phase 1 built and live; Phase 2/3 testing and tuning in progress.

Chat tuning state (from real Discord output): mining fixed (agents were muted by the progress throttle while mining failed), catchphrase cooldown, reworded-repeat filter, no-narration rule. Channel spread was still poor (last 3 h: 37 #general, 2 #town-hall, 0 #off-topic/#builds, 0 votes), so #off-topic and #builds nudges are now direct instructions (D6). Silences were the hourly post cap being spent in bursts; posts are now paced (D7). Agent logs show `held back (reason)` for every dropped line. Decisions are paced to the daily budget (D8); agent logs show `pace xN`. Check counts with the node/sqlite one-liner in HANDOFF.

## Done
- 0.1 Environment checked. Blocked in the build session: discord.com, gateway.discord.gg, cdn.discordapp.com, api/fill/fill-data.papermc.io, piston-meta/piston-data.mojang.com, libraries.minecraft.net, registry.terraform.io (plus Hetzner, Oracle, Tailscale and OpenAI, none of which are needed now). All AWS endpoints, Bedrock included, are reachable.
- 0.2 Hosting chosen: AWS eu-north-1 on a new standalone account (Paid plan), LLMs on credit-eligible Bedrock models. See DECISIONS.md.
- Bootstrap scripts written: `infra/aws/bootstrap/`.

## Blocked
- ~~Bedrock quotas~~ solved: use the `bedrock-mantle` endpoint (see DECISIONS L7). Still to confirm: mantle usage shows as credit-covered in Cost Explorer (check 2026-10-10).

## Discord
Server set up 2026-10-09. Spectator invite: https://discord.gg/pHYaWcVD2A

## Phase 1 progress
- [x] Shared lib: `agents/lib/` config, time, db (node:sqlite), llm (mantle SigV4 + cost accounting), budget, discord (webhooks + bot REST). LLM client verified live.
- [~] Agent runtime (crafting fixed via verified RCON fallback; collect rewritten; pathfinder bounded; plan pre-emption; failure backoff; loose place names): skills (`agents/src/skills.js`), brain (one JSON call = actions + chat), memory, chat pacing/caps, 3 personas, world rules. First local run works (decides, explores, posts in character). Tuning skills next.
- [~] Ops (`ops/main.js` watchdog, votes, budget pause, chronicle trigger; `ops/digest.js`; `discord/narrator.js`) written, untested.
- [~] Dockerfile + `infra/docker/compose.yml` written
- [ ] Server + compose + local integration test (local Paper 1.21.4 (seed 8675309) container `mc-dev` running in build container)
- [~] Terraform written and `terraform validate` passes: `infra/terraform/aws/bootstrap` (state bucket) and `infra/terraform/aws/main` (VPC without NAT, egress-only SG, S3 gateway endpoint, world EBS volume, data bucket with 14-day backup lifecycle, instance role under a permissions boundary, Spot ASG 0–1 with schedules 17:45/00:50 Europe/London, drain lifecycle hook, credit-guard Lambda hourly plus Budgets via SNS). **Applied 2026-10-09** after owner "go" (bootstrap 5 + main 40 resources). Credit guard Lambda tested: plan FREE, ACTIVE, $100 remaining.
- [x] Scripts: `scripts/killswitch.sh`, `scripts/resume.sh`, `scripts/deploy.sh`, `scripts/dev-run.sh`; host: `ops/host/agentcraft-backup.sh`, `ops/host/agentcraft-drain.sh`; `server/fetch-paper.sh` (pinned Paper 1.21.4 build 232, seed 8675309 + Mojang jar, checksummed)

## Next
1. Watch Discord for channel spread, first vote, chat quality; keep tuning personas.
2. Trigger-test watchdog, budget pause, kill switch, Chronicle, digest.
3. 2-hour metered 3-agent soak, cost per agent-hour, monthly cost table; owner picks a configuration.
4. Check Cost Explorer (~2026-10-10) that mantle usage is credit-covered.

## Resuming in a new session
Read this file and DECISIONS.md, then check `env | grep ^AWS_` and `aws sts get-caller-identity`.

## Known issues / to verify
- Craft/build with the wrong wood type ("oak_planks" while holding birch) is now mapped to the wood held.
- Ideas backlog (owner asked, not started): screenshots via prismarine-viewer for #builds and the Chronicle (test 1.21.4 support first); BlueMap/squaremap static web map on S3 for spectators. Not recommended: images in agent decisions (cost ~+1-1.5k tokens each, little value).
- Live 15:23-15:30 UTC: all four channels in use (#off-topic, #builds post from Tobin, a vote cast in #town-hall). Wren hit the 180 s skill timeout once collecting logs.
- Local probes need `RCON_HOST=<mc-seed container IP>` and `RCON_PASSWORD` from the container's server.properties, or the craft fallback fails with ENOTFOUND.
- Collect now tunnels to buried ore (P12); watch for agents getting stuck in tunnels or drowning (water/lava checks are in place).
- Smelting uses furnace windows; may hit the same Mineflayer window bug as crafting tables. Check in the soak test; add an RCON fallback if so.
- Paper says 'Connection throttled' when agents connect within ~4 s of each other; agents retry after 15 s. Consider `connection-throttle: -1` in bukkit.yml.
