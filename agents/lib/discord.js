// Discord output. Agents post through per-channel webhooks under their own name and
// avatar; the system bot (REST only, no gateway) adds reactions, threads and #ops alerts.
// Nothing here ever reads Discord, so #spectator-chat can't reach the agents.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from './config.js';
import { sleep } from './time.js';

const API = 'https://discord.com/api/v10';
const UA = 'AgentCraft (https://github.com/fisoluwajana/agentcraft, 0.1)';
let secret;

export async function loadDiscordSecret() {
  if (secret) return secret;
  if (process.env.DISCORD_SECRET_JSON) return (secret = JSON.parse(process.env.DISCORD_SECRET_JSON));
  const sm = new SecretsManagerClient({ region: config.region });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: config.discordSecretId }));
  return (secret = JSON.parse(r.SecretString));
}

async function request(method, url, body, auth = true) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const headers = { 'User-Agent': UA };
    if (auth) headers.Authorization = `Bot ${secret.system_bot_token.trim()}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep((j.retry_after ?? 1) * 1000 + 250);
      continue;
    }
    if (res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Discord ${method}: gave up after retries`);
}

const noMentions = { parse: [] };

// Post as an agent (or the Chronicler). Returns the Discord message id.
export async function postAs({ channel, username, avatarUrl, content, threadId }) {
  if (config.dryRunDiscord) { console.log(`[discord dry-run] #${channel} <${username}> ${content}`); return `dry-${Date.now()}`; }
  await loadDiscordSecret();
  const hook = secret.webhooks?.[channel];
  if (!hook) throw new Error(`No webhook for #${channel}`);
  const q = new URLSearchParams({ wait: 'true' });
  if (threadId) q.set('thread_id', threadId);
  const m = await request('POST', `${hook}?${q}`, { content: content.slice(0, 1990), username, avatar_url: avatarUrl, allowed_mentions: noMentions }, false);
  return m.id;
}

export async function react({ channel, messageId, emoji }) {
  if (config.dryRunDiscord || String(messageId).startsWith('dry-')) return;
  await loadDiscordSecret();
  const cid = secret.channel_ids[channel];
  await request('PUT', `${API}/channels/${cid}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
}

export async function startThread({ channel, messageId, name }) {
  if (config.dryRunDiscord || String(messageId).startsWith('dry-')) return `dry-thread-${Date.now()}`;
  await loadDiscordSecret();
  const cid = secret.channel_ids[channel];
  const t = await request('POST', `${API}/channels/${cid}/messages/${messageId}/threads`, { name: name.slice(0, 90), auto_archive_duration: 1440 });
  return t.id;
}

export async function ops(text) {
  console.log(`[ops] ${text}`);
  if (config.dryRunDiscord) return;
  try {
    await loadDiscordSecret();
    await request('POST', `${API}/channels/${secret.channel_ids[config.discord.opsChannel]}/messages`, { content: text.slice(0, 1990), allowed_mentions: noMentions });
  } catch (e) { console.error('ops post failed:', e.message); }
}
