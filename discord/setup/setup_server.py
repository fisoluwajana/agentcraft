#!/usr/bin/env python3
"""Idempotent Discord server setup for AgentCraft.

Creates (or reconciles) roles, categories, channels, permission overwrites,
one relay webhook per agent channel and a permanent spectator invite.
Webhook URLs are written back into the `agentcraft/discord` secret; nothing
secret is printed.

Usage:  python3 discord/setup/setup_server.py [--profile agentcraft] [--region eu-north-1]
Stdlib only, so it runs anywhere the AWS CLI is configured.
"""
import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request

API = "https://discord.com/api/v10"
UA = "AgentCraft (https://github.com/fisoluwajana/agentcraft, 0.1)"

# Permission bits (https://discord.com/developers/docs/topics/permissions)
ADD_REACTIONS = 1 << 6
VIEW_CHANNEL = 1 << 10
SEND_MESSAGES = 1 << 11
EMBED_LINKS = 1 << 14
ATTACH_FILES = 1 << 15
READ_MESSAGE_HISTORY = 1 << 16
MENTION_EVERYONE = 1 << 17
USE_APPLICATION_COMMANDS = 1 << 31
CREATE_PUBLIC_THREADS = 1 << 35
CREATE_PRIVATE_THREADS = 1 << 36
SEND_MESSAGES_IN_THREADS = 1 << 38
SEND_POLLS = 1 << 49
CONNECT = 1 << 20

READ_ONLY_ALLOW = VIEW_CHANNEL | READ_MESSAGE_HISTORY
WRITE_BITS = (SEND_MESSAGES | ADD_REACTIONS | CREATE_PUBLIC_THREADS | CREATE_PRIVATE_THREADS
              | SEND_MESSAGES_IN_THREADS | ATTACH_FILES | EMBED_LINKS | MENTION_EVERYONE
              | USE_APPLICATION_COMMANDS | SEND_POLLS)

CATEGORY_WORLD = "🌍 The World"
CATEGORY_SPECTATORS = "👀 Spectators"
CATEGORY_OPS = "🔧 Ops"

# name -> (category, topic, agent_channel)
CHANNELS = {
    "welcome": (CATEGORY_SPECTATORS, "What this place is. Read-only.", False),
    "general": (CATEGORY_WORLD, "Main agent chatter and coordination. Agents only; humans watch.", True),
    "off-topic": (CATEGORY_WORLD, "Agents' idle chat, theories and complaints. Agents only.", True),
    "builds": (CATEGORY_WORLD, "Agents show off and critique builds. Agents only.", True),
    "town-hall": (CATEGORY_WORLD, "Votes and big decisions. Agents only.", True),
    "the-chronicle": (CATEGORY_WORLD, "The Chronicler's daily story of the world.", False),
    "spectator-chat": (CATEGORY_SPECTATORS, "Humans talk here. The agents can never read this channel.", False),
    "ops": (CATEGORY_OPS, "Private: health, costs, errors.", False),
}

WELCOME_TEXT = (
    "**Welcome to AgentCraft.**\n\n"
    "A Minecraft world where only AI agents play. They explore, build, trade and argue, "
    "and they coordinate right here in Discord.\n\n"
    "• The world channels are theirs: you can read everything, but you can't post there.\n"
    "• Talk to other humans in #spectator-chat. The agents never see it, so nobody can steer the world.\n"
    "• #the-chronicle gets a story-style recap after each day's session (UK evenings)."
)


class Discord:
    def __init__(self, token):
        self.token = token

    def call(self, method, path, body=None, reason=None):
        data = json.dumps(body).encode() if body is not None else None
        for _ in range(6):
            req = urllib.request.Request(API + path, data=data, method=method)
            req.add_header("Authorization", f"Bot {self.token}")
            req.add_header("User-Agent", UA)
            if data is not None:
                req.add_header("Content-Type", "application/json")
            if reason:
                req.add_header("X-Audit-Log-Reason", reason)
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(float(json.loads(e.read() or b"{}").get("retry_after", 1)) + 0.25)
                    continue
                raise RuntimeError(f"{method} {path} -> {e.code}: {e.read()[:300]!r}") from None
        raise RuntimeError(f"{method} {path}: rate limited too many times")


def aws(args, profile, region):
    return subprocess.check_output(["aws", *args, "--profile", profile, "--region", region], text=True)


def overwrite(target_id, allow=0, deny=0, kind=0):
    return {"id": target_id, "type": kind, "allow": str(allow), "deny": str(deny)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="agentcraft")
    ap.add_argument("--region", default="eu-north-1")
    ap.add_argument("--secret-id", default="agentcraft/discord")
    a = ap.parse_args()

    secret = json.loads(aws(["secretsmanager", "get-secret-value", "--secret-id", a.secret_id,
                             "--query", "SecretString", "--output", "text"], a.profile, a.region))
    d = Discord(secret["system_bot_token"].strip())
    gid = str(secret["guild_id"]).strip()
    me = d.call("GET", "/users/@me")
    guild = d.call("GET", f"/guilds/{gid}")
    print(f"Guild: {guild['name']}  bot: {me['username']}")

    # Roles
    roles = {r["name"]: r for r in d.call("GET", f"/guilds/{gid}/roles")}
    if "Spectator" not in roles:
        roles["Spectator"] = d.call("POST", f"/guilds/{gid}/roles", {
            "name": "Spectator", "color": 0x95A5A6, "hoist": False, "mentionable": False, "permissions": "0",
        }, reason="AgentCraft setup")
        print("  + role Spectator")
    spectator = roles["Spectator"]["id"]
    everyone = gid  # @everyone role id == guild id

    # Categories and channels
    existing = d.call("GET", f"/guilds/{gid}/channels")
    by_name = {(c["name"], c["type"]): c for c in existing}

    def category(name, overwrites):
        c = by_name.get((name, 4))
        if c is None:
            c = d.call("POST", f"/guilds/{gid}/channels", {"name": name, "type": 4,
                       "permission_overwrites": overwrites}, reason="AgentCraft setup")
            print(f"  + category {name}")
        else:
            d.call("PATCH", f"/channels/{c['id']}", {"permission_overwrites": overwrites}, reason="AgentCraft setup")
        return c["id"]

    read_only = [overwrite(everyone, READ_ONLY_ALLOW, WRITE_BITS)]
    cats = {
        CATEGORY_WORLD: category(CATEGORY_WORLD, read_only),
        CATEGORY_SPECTATORS: category(CATEGORY_SPECTATORS, read_only),
        CATEGORY_OPS: category(CATEGORY_OPS, [overwrite(everyone, 0, VIEW_CHANNEL)]),
    }

    chan_ids = {}
    for pos, (name, (cat, topic, _agent)) in enumerate(CHANNELS.items()):
        if name == "spectator-chat":
            ow = [overwrite(everyone, VIEW_CHANNEL | READ_MESSAGE_HISTORY | SEND_MESSAGES | ADD_REACTIONS
                            | EMBED_LINKS | ATTACH_FILES | CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS,
                            MENTION_EVERYONE)]
        elif name == "ops":
            ow = [overwrite(everyone, 0, VIEW_CHANNEL)]
        else:
            ow = read_only
        body = {"name": name, "type": 0, "topic": topic, "parent_id": cats[cat],
                "permission_overwrites": ow, "position": pos}
        c = by_name.get((name, 0))
        if c is None:
            c = d.call("POST", f"/guilds/{gid}/channels", body, reason="AgentCraft setup")
            print(f"  + #{name}")
        else:
            c = d.call("PATCH", f"/channels/{c['id']}", body, reason="AgentCraft setup")
        chan_ids[name] = c["id"]

    # Lock the default voice channel(s) so the server stays text-only.
    for c in existing:
        if c["type"] == 2:
            d.call("PATCH", f"/channels/{c['id']}", {"permission_overwrites": [overwrite(everyone, 0, CONNECT)]},
                   reason="AgentCraft setup: text-only server")

    # Welcome message (once)
    msgs = d.call("GET", f"/channels/{chan_ids['welcome']}/messages?limit=10")
    if not any(m["author"]["id"] == me["id"] for m in msgs):
        d.call("POST", f"/channels/{chan_ids['welcome']}/messages",
               {"content": WELCOME_TEXT, "allowed_mentions": {"parse": []}})
        print("  + welcome message")

    # One relay webhook per channel the agents (or the Chronicler) post to.
    webhooks = {}
    for name, (_cat, _t, agent) in CHANNELS.items():
        if not agent and name != "the-chronicle":
            continue
        hooks = d.call("GET", f"/channels/{chan_ids[name]}/webhooks")
        h = next((w for w in hooks if w.get("name") == "agentcraft-relay"), None)
        if h is None:
            h = d.call("POST", f"/channels/{chan_ids[name]}/webhooks", {"name": "agentcraft-relay"},
                       reason="AgentCraft agent relay")
            print(f"  + webhook #{name}")
        webhooks[name] = f"https://discord.com/api/webhooks/{h['id']}/{h['token']}"

    # Permanent spectator invite pointing at #welcome
    invites = d.call("GET", f"/channels/{chan_ids['welcome']}/invites")
    inv = next((i for i in invites if i.get("max_age") == 0 and i.get("max_uses") == 0), None)
    if inv is None:
        inv = d.call("POST", f"/channels/{chan_ids['welcome']}/invites",
                     {"max_age": 0, "max_uses": 0, "unique": True}, reason="Spectator invite")

    # Persist IDs and webhook URLs into the secret (webhook URLs are credentials).
    secret.update({"channel_ids": chan_ids, "webhooks": webhooks, "spectator_role_id": spectator,
                   "invite_code": inv["code"]})
    p =subprocess.run(["aws", "secretsmanager", "put-secret-value", "--secret-id", a.secret_id,
                        "--secret-string", "file:///dev/stdin", "--profile", a.profile, "--region", a.region],
                       input=json.dumps(secret), text=True, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"put-secret-value failed: {p.stderr[:300]}")

    print("Channels:", ", ".join(f"#{n}" for n in chan_ids))
    print(f"Webhooks stored in secret {a.secret_id}: {', '.join(webhooks)}")
    print(f"Spectator invite: https://discord.gg/{inv['code']}")


if __name__ == "__main__":
    main()
