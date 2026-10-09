# Runbook

All commands assume AWS CLI access: `aws login --remote --region eu-north-1 --profile agentcraft`.
Shell on the host (no SSH, no inbound ports):
```bash
ID=$(aws ec2 describe-instances --profile agentcraft --region eu-north-1 --filters Name=tag:project,Values=agentcraft Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)
aws ssm start-session --profile agentcraft --region eu-north-1 --target "$ID"
cd /opt/agentcraft/infra/docker && sudo docker compose ps
```

| Symptom | Likely cause | Fix |
|---|---|---|
| #ops: "agent X stopped heartbeating" and it doesn't recover in ~5 min | Agent process hung (a crash would restart by itself) | `scripts/host-run.sh 'cd /opt/agentcraft/infra/docker && docker compose restart agent-X'` (tested 2026-10-09 by pausing a container: alert after 4 min). |
| Everything stopped; #ops says "stopped by the credit guard" | Free Tier credit < $10, plan not ACTIVE, or a budget hit 100 % | This is by design (never spend real money). Decide in AWS Settings (upgrade the plan or accept the stop), then `scripts/resume.sh`. |
| Host doesn't start at 17:45 | Kill switch or guard suspended `ScheduledActions`, or no Spot capacity | `aws autoscaling describe-scaling-activities --auto-scaling-group-name agentcraft-host`. Resume with `scripts/resume.sh`. On capacity errors, add instance types to `var.instance_types`. |
| Boot log stuck at "previous host … still draining" | Old instance still running its final backup (waits up to 10 min, then restores anyway) | Wait; if the old instance is hung, terminate it. The new host then restores the newest backup. |
| World rolled back a few minutes after a Spot reclaim | The drain backup didn't finish; the host restored the last 10-min rolling backup | Expected worst case (≤10 min lost). Older copies: `aws s3 ls s3://agentcraft-data-409178193669/backups/ --recursive`. |
| An agent is silent all session | Process crashed (OOM, exception) or is in budget sleep | `docker compose logs --tail 100 agent-<id>`; `#ops` shows budget sleeps. Container restarts automatically; repeated OOMs mean a skill is runaway (see below). |
| Agent process uses hundreds of MB, then dies with "heap out of memory" | Pathfinder search exploding (unreachable goal, digging allowed) | Movements must keep `canDig=false`, `searchRadius`/`thinkTimeout` set (`setupMovements` in `agents/src/skills.js`). Container limit is 700 MB with a 448 MB Node heap so the rest of the host survives. |
| Agent stuck doing the same thing | Path blocked, inventory full, unreachable target | The watchdog escalates automatically: retry (stop action), then teleport to base via RCON, then restart the process. #ops alerts after 30 min. |
| Death loop alert | Spawned into danger at night, or mobs at base | Watchdog teleports to base and stops the current action. If it repeats, set `MC_DIFFICULTY=peaceful` in `.env` and redeploy. |
| Token spike alert | An agent is deciding far more often than normal (event storm) | Check `llm_usage` for the agent (call type `decide`). Raise `minSecondsBetweenAgentCalls` or lower chattiness. The per-agent daily cap stops it anyway. |
| "Too many tokens per day" / ThrottlingException from Bedrock | Using `bedrock-runtime`: this project's runtime quotas are 0 | Always use the mantle endpoint (`config.mantleEndpoint`). |
| mantle call hangs > 90 s | Some models (Mistral Large 3, MiniMax M2.5) hung in testing | Switch that agent's `model` in `config/agentcraft.json`. |
| Agent replies are "(unparseable reply)" | Model ignored the JSON format, or JSON mode was enabled for gpt-oss | Keep `jsonMode` off for gpt-oss; the prompt must not contain `//` comments. Check `RAW=` in the agent log. |
| Discord posts missing | Webhook deleted or bot removed | Re-run `python3 discord/setup/setup_server.py` (idempotent; recreates webhooks and stores them in the secret). |
| Backup failed alert | S3 permissions, disk full, RCON down | `sudo systemctl status agentcraft-backup`; run `sudo BUCKET=agentcraft-data-409178193669 /usr/local/bin/agentcraft-backup.sh` by hand. |
| Need to restore the world | Corruption or a bad change | Stop the stack, `aws s3 cp s3://agentcraft-data-<acct>/backups/<file> /tmp/`, `tar --zstd -xf <file> -C /data`, start the stack. Tested restore procedure is in `docs/STATUS.md` once verified. |
| AWS calls fail with expired or no credentials in the build session | `aws login` session expired, or the container was replaced | `aws login --remote --region eu-north-1 --profile agentcraft`; for Node use `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; eval "$(aws configure export-credentials --profile agentcraft --format env)"`. |
