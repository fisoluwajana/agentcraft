// Ops process: watchdog, vote closing, global budget pause, nightly Chronicle,
// weekly digests. Runs alongside the agents in its own container.
import { Rcon } from 'rcon-client';
import { config } from '../agents/lib/config.js';
import { openDb, now, kvGet, kvSet, logEvent } from '../agents/lib/db.js';
import { seasonMinute, seasonLengthMinutes, seasonDay, localParts, sleep } from '../agents/lib/time.js';
import { spend } from '../agents/lib/budget.js';
import { ops, postAs } from '../agents/lib/discord.js';
import { runChronicle, runWeeklyRecap } from '../discord/narrator.js';
import { weeklyDigest } from './digest.js';

const log = (...a) => console.log(new Date().toISOString(), '[ops]', ...a);
const STUCK_MIN = 10;          // no movement and no progress for this long = stuck
const ALERT_STUCK_MIN = 30;    // brief: alert when an agent is stuck > 30 min
const DEATH_LOOP = 4;          // deaths in 20 min

async function rcon(cmd) {
  const r = await Rcon.connect({ host: process.env.RCON_HOST || config.minecraft.host, port: config.minecraft.rconPort, password: config.minecraft.rconPassword, timeout: 5000 });
  try { return await r.send(cmd); } finally { r.end(); }
}

function command(target, cmd, args = {}) {
  openDb().prepare('INSERT INTO commands(ts,target,command,args) VALUES(?,?,?,?)').run(now(), target, cmd, JSON.stringify(args));
}

// ---------------------------------------------------------------- watchdog
const recovery = {}; // agent -> {stage, since}

async function watchdog() {
  if (process.env.IGNORE_SEASON !== '1' && seasonMinute() == null) return;
  const db = openDb();
  const day = seasonDay();
  for (const a of config.agents) {
    const s = db.prepare('SELECT * FROM agent_status WHERE agent=?').get(a.id);
    if (!s || s.state === 'budget_sleep') continue;
    const name = config.agents.find((x) => x.id === a.id) && a.id;
    const staleMin = (now() - (s.ts || 0)) / 60000;
    if (staleMin > 3) { // process not heartbeating
      if (!recovery[a.id] || recovery[a.id].stage !== 'dead') { await ops(`💥 agent **${a.id}** stopped heartbeating ${Math.round(staleMin)} min ago. A crash restarts by itself; if it's hung, see RUNBOOK (restart agent-${a.id}).`); recovery[a.id] = { stage: 'dead', since: now() }; }
      continue;
    }
    const idleMin = Math.min(now() - (s.last_move_ts || now()), now() - (s.last_progress_ts || now())) / 60000;
    const repeat = s.action_repeat || 0;
    const deaths = db.prepare("SELECT COUNT(*) n FROM events WHERE agent=? AND kind='death' AND ts>?").get(a.id, now() - 20 * 60000).n;
    const r = recovery[a.id] || { stage: 'ok', since: now() };

    if (deaths >= DEATH_LOOP) {
      await ops(`☠️ death loop: **${a.id}** died ${deaths} times in 20 min. Teleporting to base and pausing actions.`);
      await tpToBase(a.id).catch((e) => log('tp failed', e.message));
      command(a.id, 'stop_action');
      logEvent(day, a.id, 'watchdog', { action: 'death_loop_tp' });
      continue;
    }

    if (idleMin < STUCK_MIN && repeat < 6) { if (r.stage !== 'ok') { recovery[a.id] = { stage: 'ok', since: now() }; } continue; }

    // Recovery ladder: retry -> teleport to base -> restart process
    if (r.stage === 'ok') {
      command(a.id, 'stop_action'); command(a.id, 'note', { text: 'you seem stuck; try something different' });
      recovery[a.id] = { stage: 'retried', since: now() }; logEvent(day, a.id, 'watchdog', { action: 'retry', idleMin, repeat });
    } else if (r.stage === 'retried' && now() - r.since > 5 * 60000) {
      await tpToBase(a.id).catch((e) => log('tp failed', e.message));
      recovery[a.id] = { stage: 'teleported', since: now() }; logEvent(day, a.id, 'watchdog', { action: 'teleport' });
    } else if (r.stage === 'teleported' && now() - r.since > 5 * 60000) {
      command(a.id, 'restart');
      recovery[a.id] = { stage: 'restarted', since: now() }; logEvent(day, a.id, 'watchdog', { action: 'restart' });
    }
    if (idleMin > ALERT_STUCK_MIN && !r.alerted) { await ops(`🧱 **${a.id}** stuck for ${Math.round(idleMin)} min (stage: ${recovery[a.id].stage}).`); recovery[a.id].alerted = true; }
    void name;
  }

  // Token-burn spike: any agent spending > 3x its hourly average in the last 10 min.
  const perAgentHour = config.budgets.perAgentDailyUsd / (seasonLengthMinutes() / 60);
  for (const a of config.agents) {
    const last10 = openDb().prepare('SELECT COALESCE(SUM(usd),0) u FROM llm_usage WHERE agent=? AND ts>?').get(a.id, now() - 600_000).u;
    if (last10 > (perAgentHour / 6) * 3 && !kvGet(`spike:${a.id}:${day}`)) {
      kvSet(`spike:${a.id}:${day}`, true);
      await ops(`🔥 token spike: **${a.id}** spent $${last10.toFixed(3)} in 10 min (normal ≈ $${(perAgentHour / 6).toFixed(3)}).`);
    }
  }
}

async function tpToBase(agentId) {
  const p = openDb().prepare("SELECT x,y,z FROM pois WHERE lower(name)='base'").get();
  const name = { mags: 'Mags', tobin: 'Tobin', wren: 'Wren' }[agentId] || agentId;
  const dest = p ? `${p.x} ${p.y + 1} ${p.z}` : null;
  await rcon(dest ? `tp ${name} ${dest}` : `execute in minecraft:overworld run tp ${name} ~ ~ ~`);
  if (!dest) await rcon(`spreadplayers 0 0 0 16 false ${name}`);
}

// ---------------------------------------------------------------- votes
async function closeVotes() {
  const db = openDb();
  for (const v of db.prepare("SELECT * FROM votes WHERE status='open' AND closes_ts<?").all(now())) {
    const ballots = db.prepare('SELECT option, COUNT(*) n FROM ballots WHERE vote_id=? GROUP BY option ORDER BY n DESC').all(v.id);
    const result = ballots[0] ? (ballots[1] && ballots[1].n === ballots[0].n ? 'tie' : ballots[0].option) : 'no votes';
    db.prepare("UPDATE votes SET status='closed', result=? WHERE id=?").run(result, v.id);
    const text = `🗳️ **Vote #${v.id} closed:** ${v.question}\n**Result: ${result}** (${ballots.map((b) => `${b.option}: ${b.n}`).join(', ') || 'no ballots'})`;
    db.prepare("INSERT INTO chat(ts,day,channel,author,text,kind) VALUES(?,?,?,?,?,'system')").run(now(), seasonDay(), 'town-hall', 'Town Ledger', text);
    await postAs({ channel: 'town-hall', username: 'Town Ledger', avatarUrl: 'https://api.dicebear.com/9.x/icons/png?seed=ledger&size=128', content: text }).catch((e) => log('ledger post failed', e.message));
    logEvent(seasonDay(), null, 'vote_closed', { id: v.id, question: v.question, result });
  }
}

// Every ~2 h with no open vote, ask one agent (rotating) whether a group decision needs settling.
function decisionNudge() {
  const db = openDb();
  if (db.prepare("SELECT COUNT(*) n FROM votes WHERE status='open'").get().n) return;
  const last = kvGet('decision_nudge_ts', 0);
  if (now() - last < 2 * 3600_000) return;
  if (db.prepare("SELECT COUNT(*) n FROM chat WHERE kind='message' AND ts>?").get(now() - 3600_000).n < 10) return; // only once they're actually talking
  const i = kvGet('decision_nudge_i', 0);
  const a = config.agents[i % config.agents.length];
  command(a.id, 'note', { text: 'Is there a group decision worth settling properly (where the base goes, what it is called, who owns which job, what to build next)? If people disagree, propose a vote in #town-hall with 2-3 clear options. If nothing needs deciding, ignore this.' });
  kvSet('decision_nudge_ts', now()); kvSet('decision_nudge_i', i + 1);
}

// ---------------------------------------------------------------- global budget
async function budgetCheck() {
  const s = spend({});
  const pct = (100 * s.monthUsd) / config.budgets.monthlyLlmUsd;
  for (const t of [50, 80, 100]) {
    const k = `llm_budget_alert:${t}:${localParts().y}-${localParts().m}`;
    if (pct >= t && !kvGet(k)) {
      kvSet(k, true);
      await ops(`💸 LLM spend at ${Math.round(pct)}% of the $${config.budgets.monthlyLlmUsd} monthly ceiling ($${s.monthUsd.toFixed(2)}).${t >= 100 ? ' **All agents paused.**' : ''}`);
    }
  }
  if (pct >= 100 && !kvGet('pause')) kvSet('pause', { reason: 'monthly LLM ceiling reached', ts: now() });
}

// ---------------------------------------------------------------- schedule
async function tick() {
  await watchdog().catch((e) => log('watchdog error', e.message));
  await closeVotes().catch((e) => log('votes error', e.message));
  try { if (process.env.IGNORE_SEASON === '1' || seasonMinute() != null) decisionNudge(); } catch (e) { log('nudge error', e.message); }
  await budgetCheck().catch((e) => log('budget error', e.message));

  // Chronicle: once per season day, shortly after the session ends.
  const day = seasonDay();
  const sm = seasonMinute();
  const ended = sm == null && localParts().hh < 6;
  if (ended && !kvGet(`chronicle:${day}`)) {
    kvSet(`chronicle:${day}`, 'running');
    try { await runChronicle(day); kvSet(`chronicle:${day}`, 'done'); } catch (e) { kvSet(`chronicle:${day}`, null); await ops(`📜 Chronicle failed: ${e.message}`); }
    const dow = new Date().getUTCDay();
    if (dow === 1 && !kvGet(`weekly:${day}`)) { // Sunday's session ends after midnight UTC Monday
      kvSet(`weekly:${day}`, true);
      await runWeeklyRecap(day).catch((e) => ops(`📜 weekly recap failed: ${e.message}`));
      await weeklyDigest().catch((e) => ops(`📊 digest failed: ${e.message}`));
    }
  }
}

log('ops started');
await ops('🟢 ops online (watchdog, votes, budgets, chronicle).').catch(() => {});
while (true) { await tick(); await sleep(60_000); }
