"""AgentCraft credit guard.

Triggered hourly (EventBridge Scheduler) and by AWS Budgets alerts (via SNS).
Stops everything when Free Tier credit drops below the floor, the plan stops being
ACTIVE, or a budget hits 100%. Posts every alert to Discord #ops.
"""
import json
import os
import urllib.request

import boto3

ASG = os.environ["ASG_NAME"]
FLOOR = float(os.environ.get("CREDIT_FLOOR_USD", "10"))
SECRET = os.environ.get("DISCORD_SECRET", "agentcraft/discord")

asg = boto3.client("autoscaling")
freetier = boto3.client("freetier", region_name="us-east-1")
sm = boto3.client("secretsmanager")


def ops(text):
    try:
        s = json.loads(sm.get_secret_value(SecretId=SECRET)["SecretString"])
        req = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{s['channel_ids']['ops']}/messages",
            data=json.dumps({"content": text[:1990], "allowed_mentions": {"parse": []}}).encode(),
            headers={"Authorization": f"Bot {s['system_bot_token'].strip()}", "Content-Type": "application/json",
                     "User-Agent": "AgentCraft guard (github.com/fisoluwajana/agentcraft, 0.1)"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # never let alerting break the stop
        print("ops post failed:", e)


def stop_everything(reason):
    asg.update_auto_scaling_group(AutoScalingGroupName=ASG, MinSize=0, MaxSize=0, DesiredCapacity=0)
    asg.suspend_processes(AutoScalingGroupName=ASG, ScalingProcesses=["ScheduledActions"])
    ops(f"🛑 **AgentCraft stopped by the credit guard**: {reason}\nThe world volume and backups are kept. To resume: `scripts/resume.sh` (after you've decided what to do).")
    print("STOPPED:", reason)


def handler(event, _ctx):
    # Budget alert via SNS
    for rec in event.get("Records", []):
        msg = rec.get("Sns", {}).get("Message", "")
        subject = rec.get("Sns", {}).get("Subject", "") or "AWS Budgets alert"
        ops(f"💸 {subject}\n{msg[:800]}")
        if "100" in subject or "exceeded" in subject.lower():
            stop_everything(f"budget alert: {subject}")
        return {"ok": True}

    # Hourly credit check
    st = freetier.get_account_plan_state()
    plan = st.get("accountPlanType")
    status = st.get("accountPlanStatus")
    remaining = float(st.get("accountPlanRemainingCredits", {}).get("amount", 0))
    print(json.dumps({"plan": plan, "status": status, "remaining": remaining}))
    group = asg.describe_auto_scaling_groups(AutoScalingGroupNames=[ASG])["AutoScalingGroups"][0]
    already = group["MaxSize"] == 0
    if status != "ACTIVE":
        if not already:
            stop_everything(f"account plan status is {status}")
    elif remaining < FLOOR:
        if not already:
            stop_everything(f"only ${remaining:.2f} of Free Tier credit left (floor ${FLOOR:.0f})")
    elif remaining < FLOOR * 2.5 and event.get("source") == "schedule":
        ops(f"⚠️ Free Tier credit is down to ${remaining:.2f}; everything stops at ${FLOOR:.0f}.")
    return {"plan": plan, "status": status, "remaining": remaining, "stopped": already}
