// One agent process: `AGENT_ID=mags node agents/src/agent.js`
// Event-driven: the LLM is only called when something meaningful happens.
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import toolPlugin from 'mineflayer-tool';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config, agentConfig, ROOT } from '../lib/config.js';
import { openDb, now, logEvent, kvGet } from '../lib/db.js';
import { seasonMinute, seasonLengthMinutes, seasonDay, sleep } from '../lib/time.js';
import { BudgetExceeded } from '../lib/budget.js';
import { ops, postAs } from '../lib/discord.js';
import { SKILLS, SkillError, setupMovements, scanSurroundings, invCounts, withTimeout } from './skills.js';
import { Memory } from './memory.js';
import { Chat } from './chat.js';
import { decide, applyCivics } from './brain.js';

const ID = process.env.AGENT_ID;
const A = agentConfig(ID);
const P = A.persona;
const IGNORE_SEASON = process.env.IGNORE_SEASON === '1';
const log = (...a) => console.log(new Date().toISOString(), `[${ID}]`, ...a);

async function loadAgenda() {
  const local = path.join(ROOT, 'agents/personas/private/agendas.json');
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'))[ID];
  try {
    const sm = new SecretsManagerClient({ region: config.region });
    const r = await sm.send(new GetSecretValueCommand({ SecretId: config.agendasSecretId }));
    return JSON.parse(r.SecretString)[ID];
  } catch (e) { log('no agenda:', e.message); return null; }
}

export const LEDGER = { username: 'Town Ledger', avatarUrl: 'https://api.dicebear.com/9.x/icons/png?seed=ledger&size=128' };

async function announceVote(v) {
  const text = `🗳️ **Vote #${v.id}** (proposed by ${v.by}): ${v.question}\n${v.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nCloses in ${v.hours} h.`;
  openDb().prepare("INSERT INTO chat(ts,day,channel,author,text,kind) VALUES(?,?,?,?,?,'system')").run(now(), seasonDay(), 'town-hall', LEDGER.username, text);
  await postAs({ channel: 'town-hall', ...LEDGER, content: text });
}

class Agent {
  constructor(agenda) {
    this.agenda = agenda;
    this.mem = new Memory(ID, P);
    this.chat = new Chat(ID, P);
    this.events = [];          // pending meaningful events for the next decision
    this.busy = false;
    this.lastDecision = 0;
    this.lastProgress = now();
    this.currentAction = null;
    this.asleepForBudget = false;
    this.saidGoodnight = false;
  }

  push(kind, text, urgent = false) {
    this.events.push({ kind, text, urgent, ts: now() });
    if (this.events.length > 12) this.events.shift();
    this.mem.remember(kind, text);
  }

  progress(text) {
    this.lastProgress = now();
    logEvent(seasonDay(), ID, 'progress', { text });
  }

  ctxApi() {
    return {
      discover: (f) => {
        const name = `${f.kind} near ${Math.round(f.x / 10) * 10},${Math.round(f.z / 10) * 10}`;
        const r = openDb().prepare('INSERT OR IGNORE INTO pois(name,kind,x,y,z,found_by,ts) VALUES(?,?,?,?,?,?,?)').run(name, f.kind, f.x, f.y, f.z, P.name, now());
        if (r.changes) { this.push('discovery', `found ${f.kind} at ${f.x},${f.y},${f.z}`, ['diamonds', 'a village', 'iron'].includes(f.kind)); logEvent(seasonDay(), ID, 'discovery', f); }
      },
      poi: (p) => openDb().prepare('INSERT INTO pois(name,kind,x,y,z,found_by,ts,note) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET x=excluded.x,y=excluded.y,z=excluded.z,note=excluded.note').run(p.name, p.kind, p.x, p.y, p.z, P.name, now(), p.note || null),
      ledger: (item, delta, place, note) => openDb().prepare('INSERT INTO ledger(ts,agent,item,delta,place,note) VALUES(?,?,?,?,?,?)').run(now(), P.name, item, delta, place, note),
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: config.minecraft.host, port: config.minecraft.port, username: P.minecraftName,
        version: config.minecraft.version, auth: 'offline', hideErrors: true, checkTimeoutInterval: 60_000,
      });
      bot.loadPlugin(pf.pathfinder);
      bot.loadPlugin(toolPlugin.plugin);
      bot.once('spawn', () => { setupMovements(bot); resolve(bot); });
      bot.once('error', reject);
      bot.once('kicked', (r) => reject(new Error(`kicked: ${JSON.stringify(r).slice(0, 200)}`)));
      bot.on('death', () => {
        this.push('death', 'died and respawned at spawn; lost what I was carrying', true);
        openDb().prepare('UPDATE agent_status SET deaths_today=deaths_today+1 WHERE agent=?').run(ID);
        logEvent(seasonDay(), ID, 'death', {});
      });
      bot.on('health', () => { if (bot.health < 7 && !this._lowHealthFlag) { this._lowHealthFlag = true; this.push('danger', `health low (${Math.round(bot.health)}/20)`, true); } if (bot.health > 14) this._lowHealthFlag = false; });
      bot.on('entityHurt', (e) => { if (e === bot.entity) { const mob = bot.nearestEntity((x) => x.type === 'hostile'); if (mob && mob.position.distanceTo(bot.entity.position) < 8 && !this.busyFighting) this.push('danger', `being attacked by a ${mob.name}`, true); } });
      bot.on('end', (reason) => { log('disconnected:', reason); this.bot = null; });
      this.bot = bot;
    });
  }

  heartbeat() {
    const b = this.bot;
    if (!b?.entity) return;
    const p = b.entity.position;
    const prev = openDb().prepare('SELECT x,z,last_move_ts FROM agent_status WHERE agent=?').get(ID);
    const moved = !prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 1.5;
    openDb().prepare(`INSERT INTO agent_status(agent,ts,x,y,z,health,food,action,state,last_move_ts,last_progress_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent) DO UPDATE SET ts=excluded.ts,x=excluded.x,y=excluded.y,z=excluded.z,health=excluded.health,food=excluded.food,action=excluded.action,state=excluded.state,
      last_move_ts=CASE WHEN ? THEN excluded.ts ELSE agent_status.last_move_ts END, last_progress_ts=excluded.last_progress_ts`)
      .run(ID, now(), p.x, p.y, p.z, b.health, b.food, this.currentAction?.skill || null, this.asleepForBudget ? 'budget_sleep' : 'active', now(), this.lastProgress, moved ? 1 : 0);
  }

  // Commands from the watchdog (ops process) via SQLite.
  async pollCommands() {
    const cmds = openDb().prepare('SELECT * FROM commands WHERE target=? AND done_ts IS NULL ORDER BY id').all(ID);
    for (const c of cmds) {
      openDb().prepare('UPDATE commands SET done_ts=? WHERE id=?').run(now(), c.id);
      log('command', c.command);
      if (c.command === 'stop_action') { this.bot?.pathfinder?.stop(); this.abort = true; }
      if (c.command === 'restart') { this.bot?.quit('restart'); process.exit(0); }
      if (c.command === 'note') this.push('notice', JSON.parse(c.args || '{}').text || '');
    }
  }

  readChat() {
    for (const m of this.chat.unread()) {
      if (!config.discord.worldChannels.includes(m.channel)) continue;
      const mine = this.chat.addressedToMe(m);
      // Only some agents respond to any given message: unaddressed chatter is noticed, and only sometimes acted on.
      if (mine) this.push('chat', `${m.author} to me in #${m.channel}: ${m.text}`, true);
      else if (Math.random() < P.chattiness * 0.35) this.push('chat', `${m.author} in #${m.channel}: ${m.text}`);
    }
  }

  progressLastHour() {
    return openDb().prepare("SELECT COUNT(*) n FROM events WHERE agent=? AND kind='progress' AND ts>?").get(ID, now() - 3600_000).n;
  }

  shouldDecide() {
    const gap = (now() - this.lastDecision) / 1000;
    const urgent = this.events.some((e) => e.urgent);
    // Back off after consecutive failed plans so a stuck agent doesn't burn a call every 20 s.
    const minGap = config.budgets.minSecondsBetweenAgentCalls * Math.min(2 ** (this.failStreak || 0), 8);
    if (gap < minGap) return false;
    if (urgent) return true;
    if (this.busy) return false;
    if (this.events.length) return true;
    return gap > 90; // idle: nothing queued for a while
  }

  async think() {
    const b = this.bot;
    const t = b.time.timeOfDay;
    const tod = t < 1000 ? 'early morning' : t < 6000 ? 'morning' : t < 11000 ? 'afternoon' : t < 13000 ? 'sunset' : t < 23000 ? 'night' : 'dawn';
    const sm = seasonMinute();
    const minutesLeft = sm == null ? 60 : seasonLengthMinutes() - sm;
    const events = this.events.splice(0).map((e) => e.text);
    if (!events.length) events.push('nothing new; you are free to pick what to do');
    // Models ignore soft channel hints, so ask directly, at most every ~25 min per agent.
    if (events.length <= 2 && now() - (this.lastOffTopicAsk || 0) > 25 * 60_000 && !this.chat.postedRecently('off-topic', 25 * 60_000)) {
      this.lastOffTopicAsk = now();
      events.push('Post ONE short message in #off-topic now, not about the current job: a gripe, a joke, a theory about this world, gossip about someone, a random thought. In your own voice.');
    }
    const others = Object.keys(b.players).filter((n) => n !== b.username && b.players[n].entity).map((n) => `${n} (${Math.round(b.players[n].entity.position.distanceTo(b.entity.position))}m)`);
    const goals = this.mem.goals;
    this.lastDecision = now();
    const d = await decide({ agentId: ID, model: A.model, persona: P, agenda: this.agenda,
      ctx: { bot: b, mem: this.mem, chatLog: this.chat.recentAcross(), events, others, timeOfDay: tod, minutesLeft, goals } });
    log(`think ($${(d._usd || 0).toFixed(5)}): ${d.thought || ''}${d._raw ? ` RAW=${JSON.stringify(d._raw)}` : ''} | plan=${d.plan.map((s) => s.skill).join(',') || '-'} | say=${d.say.length}`);
    if (Array.isArray(d.goals) && d.goals.length) this.mem.goals = d.goals.slice(0, 5).map((g) => ({ goal: String(g).slice(0, 140), status: 'open' }));
    for (const r of Array.isArray(d.relationships) ? d.relationships : []) this.mem.updateRelationship(String(r.who || '').toLowerCase(), r);
    const civics = applyCivics(P.name, d);
    for (const c of civics) { this.push('civics', c); this.progress(c); }
    if (civics.announce) await announceVote(civics.announce).catch((e) => log('vote announce failed', e.message));
    if (d.react?.length) for (const r of d.react.slice(0, 2)) await this.chat.reactTo(r.message_id, r.emoji);
    if (d.vote && d.say.length) d.say = d.say.map((x) => ({ ...x, civic: true }));
    if (d.say.length) this.chat.say(d.say, this.progressLastHour()).catch((e) => log('say failed', e.message));
    if (d.plan.length) await this.replacePlan(d.plan);
  }

  // A new plan pre-empts the running one; never let two plans drive the bot at once.
  async replacePlan(plan) {
    if (this.planPromise) {
      this.abort = true;
      try { this.bot.pathfinder.stop(); this.bot.stopDigging?.(); } catch { /* ignore */ }
      await Promise.race([this.planPromise, sleep(8000)]);
    }
    this.planPromise = this.runPlan(plan).finally(() => { this.planPromise = null; });
  }

  async runPlan(plan) {
    this.busy = true; this.abort = false;
    try {
      for (const step of plan) {
        if (this.abort) break;
        this.currentAction = step;
        openDb().prepare('UPDATE agent_status SET action=?, action_started=?, action_repeat=CASE WHEN action=? THEN action_repeat+1 ELSE 0 END WHERE agent=?')
          .run(step.skill, now(), step.skill, ID);
        const before = invCounts(this.bot);
        try {
          const res = await withTimeout(SKILLS[step.skill].run(this.bot, step.args || {}, this.ctxApi()), 180_000, step.skill)
            .catch((e) => { try { this.bot.pathfinder.stop(); this.bot.stopDigging?.(); } catch { /* ignore */ } throw e; });
          log(`✓ ${step.skill}: ${res.summary}`);
          this.failStreak = 0;
          this.push('done', `${step.skill}: ${res.summary}`);
          const gainedAny = res.gained && Object.values(res.gained).some((v) => v > 0);
          if (gainedAny || res.built || ['store', 'give', 'mark', 'craft', 'smelt'].includes(step.skill)) this.progress(res.summary);
          if (step.skill === 'explore') for (const f of scanSurroundings(this.bot)) this.ctxApi().discover(f);
          if (res.built || step.skill.startsWith('build')) this.push('built', `finished: ${res.summary}. Post about it in #builds (not #general): what it is, where, and how you feel about it`, true);
        } catch (e) {
          const msg = e instanceof SkillError ? e.message : `${e.message}`.slice(0, 160);
          log(`✗ ${step.skill}: ${msg}`);
          this.failStreak = (this.failStreak || 0) + 1;
          this.push('failed', `${step.skill} failed: ${msg}`, true);
          break;
        }
        void before;
      }
    } finally { this.busy = false; this.currentAction = null; }
  }

  async budgetBedtime(err) {
    this.asleepForBudget = true;
    log('budget stop:', err.message);
    logEvent(seasonDay(), ID, 'budget_sleep', { reason: err.message });
    const lines = { mags: 'right thats me done. doris needs a rest', tobin: "ok i'm DEAD tired 😭 calling it early, don't touch my stuff", wren: "I'm turning in early. Don't let anyone near the wheat." };
    if (err.scope === 'agent') await this.chat.say([{ channel: 'general', text: lines[ID] || 'heading to bed early' }], 99).catch(() => {});
    else await ops(`⏸️ ${P.name} paused: ${err.message}`);
  }

  async seasonTick() {
    const sm = seasonMinute();
    const left = sm == null ? null : seasonLengthMinutes() - sm;
    if (!this.saidGoodnight && left != null && left <= config.season.bedtimeWarningMinutes) {
      this.saidGoodnight = true;
      this.push('bedtime', `the session ends in ${left} minutes; wrap up, put things away, say goodnight your way`, true);
    }
  }

  async run() {
    openDb();
    while (true) {
      const inSeason = IGNORE_SEASON || seasonMinute() != null;
      if (!inSeason || kvGet('pause')) {
        if (this.bot) { log('session over; logging off'); this.bot.quit('bedtime'); this.bot = null; await this.mem.summarise(true).catch(() => {}); }
        this.saidGoodnight = false; this.asleepForBudget = false;
        await sleep(60_000); continue;
      }
      if (this.asleepForBudget) { if (this.bot) { this.bot.quit('budget'); this.bot = null; } await sleep(60_000); continue; }
      if (!this.bot) {
        try {
          await this.connect();
          log('spawned at', this.bot.entity.position.floored().toString());
          this.push('wake', 'logged in for today\'s session', true);
        } catch (e) { log('connect failed:', e.message); await sleep(15_000); continue; }
      }
      try {
        this.heartbeat();
        await this.pollCommands();
        this.readChat();
        await this.seasonTick();
        if (this.bot.food < 8 && !this.busy && this.bot.inventory.items().some((i) => this.bot.registry.foodsByName[i.name])) await SKILLS.eat.run(this.bot).catch(() => {});
        if (this.shouldDecide()) await this.think();
        if (this.mem.sinceSummary >= 30) this.mem.summarise().catch((e) => log('summary failed', e.message));
      } catch (e) {
        if (e instanceof BudgetExceeded) await this.budgetBedtime(e);
        else { log('loop error:', e.message); await sleep(5000); }
      }
      await sleep(2000);
    }
  }
}

process.on('unhandledRejection', (e) => log('unhandled:', e?.message || e));
const agenda = await loadAgenda();
log(`starting: model=${A.model}`);
new Agent(agenda).run();
