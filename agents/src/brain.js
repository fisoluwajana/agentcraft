// The decision step: one LLM call returns both the next actions and anything to say.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../lib/config.js';
import { chat, parseJsonLoose } from '../lib/llm.js';
import { openDb, now } from '../lib/db.js';
import { skillIndex, SKILLS } from './skills.js';

const WORLD = readFileSync(path.join(ROOT, 'agents/prompts/world.md'), 'utf8');

const OUTPUT = `REPLY WITH ONE JSON OBJECT AND NOTHING ELSE. Valid JSON: double quotes, no comments, no trailing commas.
Fields:
- "thought": one short private sentence about what you're doing and why.
- "plan": list of 0-3 steps run in order, each {"skill": "<name>", "args": {...}}. Use [] to keep doing nothing new.
- "say": list of chat messages, usually [] (silence is normal) or 1; up to 3 short ones only if that's how you type. Each {"channel": "general"|"off-topic"|"builds"|"town-hall", "text": "...", "reply_to_id": <chat id, optional>, "thread": "<new thread name, optional>"}.
- "react": optional list of {"message_id": <chat id>, "emoji": "👍"} instead of replying.
- "goals": optional list of up to 5 personal goals (strings) if they changed.
- "relationships": optional, only after something notable: list of {"who": "<name>", "opinion_delta": -2..2, "notes": "...", "debts": "...", "jokes": "..."}.
- "task": optional, one of {"create": {"title": "...", "detail": "..."}}, {"claim": <id>}, {"done": <id>}, {"release": <id>}.
- "vote": optional, one of {"propose": {"question": "...", "options": ["...", "..."], "hours": 24}} or {"cast": {"vote_id": <id>, "option": "...", "reason": "..."}}.
Example: {"thought": "need wood before anything", "plan": [{"skill": "collect", "args": {"block": "log", "count": 12}}], "say": [], "react": []}`;

export function systemPrompt(persona, agenda) {
  const t = persona.typingStyle;
  return `You are ${persona.name} (${persona.pronouns}). You are a real player in this world, not an AI and not an assistant.

WHO YOU ARE
Role: ${persona.role}
Personality: ${persona.personality}
Values: ${persona.values.join('; ')}
Quirks: ${persona.quirks.join('; ')}
Likes: ${persona.likes.join(', ')}. Dislikes: ${persona.dislikes.join(', ')}.
Private agenda (secret, never state it outright): ${agenda || 'none'}

HOW YOU TYPE (follow exactly)
Case: ${t.case}. Punctuation: ${t.punctuation}. Emoji: ${t.emoji}. Length: ${t.length}. Typos: ${t.typos}. Habits: ${t.habits}.
Catchphrases (use rarely: at most one in every 6-8 messages, only when it fits; never open messages the same way twice in a row): ${persona.catchphrases.join(' | ')}
Never say any of: ${persona.never.join(' | ')}

${WORLD}
SKILLS YOU CAN USE IN "plan"
${skillIndex()}

${OUTPUT}`;
}

function inventoryText(bot) {
  const c = {};
  for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count;
  const s = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k, v]) => `${k}×${v}`).join(', ');
  return s || 'empty';
}

function worldText() {
  const db = openDb();
  const pois = db.prepare('SELECT name,kind,x,y,z,found_by FROM pois ORDER BY ts DESC LIMIT 12').all();
  const tasks = db.prepare("SELECT id,title,status,claimed_by FROM tasks WHERE status IN ('open','claimed') ORDER BY id DESC LIMIT 8").all();
  const votes = db.prepare("SELECT id,question,options FROM votes WHERE status='open'").all();
  const chest = db.prepare('SELECT item, SUM(delta) n FROM ledger GROUP BY item HAVING n>0 ORDER BY n DESC LIMIT 12').all();
  return [
    `Map: ${pois.map((p) => `${p.name} [${p.kind}] ${p.x},${p.y},${p.z}`).join('; ') || 'nothing marked yet'}`,
    `Task board: ${tasks.map((t) => `#${t.id} ${t.title} (${t.status}${t.claimed_by ? ` by ${t.claimed_by}` : ''})`).join('; ') || 'empty'}`,
    `Open votes: ${votes.map((v) => `#${v.id} ${v.question} options ${v.options}`).join('; ') || 'none'}`,
    `Community chest (per ledger): ${chest.map((c) => `${c.item}×${c.n}`).join(', ') || 'empty'}`,
  ].join('\n');
}

export function userPrompt({ bot, mem, chatLog, events, others, timeOfDay, minutesLeft, goals }) {
  const p = bot.entity.position;
  const fmt = (m) => `[${m.id}] ${m.author}${m.reply_to ? ` (replying to ${m.reply_to})` : ''}: ${m.text}`;
  const byChan = {};
  for (const m of chatLog) (byChan[m.channel] ||= []).push(m);
  const lines = Object.entries(byChan).map(([c, ms]) => `#${c}\n${ms.map(fmt).join('\n')}`).join('\n') || '(quiet)';
  return `NOW
Position ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}. Health ${Math.round(bot.health)}/20, food ${Math.round(bot.food)}/20. In-game ${timeOfDay}. About ${minutesLeft} min of today's session left.
Inventory: ${inventoryText(bot)}
Nearby players: ${others.join(', ') || 'nobody'}

WHAT JUST HAPPENED
${events.map((e) => `- ${e}`).join('\n')}

RECENT CHAT (ids in brackets)
${lines}

YOUR NOTES
${mem.notes || '(none yet)'}

RECENT MEMORY
${mem.recentText(6)}

YOUR GOALS
${goals.map((g) => `- ${g.goal}${g.status !== 'open' ? ` (${g.status})` : ''}`).join('\n')}

HOW YOU FEEL ABOUT THE OTHERS
${mem.relationshipsText(Object.keys(config.agents.reduce((a, x) => ({ ...a, [x.id]: 1 }), {})).filter((n) => n !== mem.id))}

WORLD STATE
${worldText()}

Decide what to do next. Reply with JSON only.`;
}

export async function decide({ agentId, model, persona, agenda, ctx }) {
  const messages = [
    { role: 'system', content: systemPrompt(persona, agenda) },
    { role: 'user', content: userPrompt(ctx) },
  ];
  const r = await chat({ agent: agentId, callType: 'decide', model, messages, maxTokens: 700, json: true, temperature: 0.85 });
  let d = parseJsonLoose(r.text);
  if (!d && r.reasoning) d = parseJsonLoose(r.reasoning);
  if (!d) return { plan: [], say: [], thought: '(unparseable reply)', _raw: r.text?.slice(0, 200), _usd: r.usd };
  d.plan = (Array.isArray(d.plan) ? d.plan : []).filter((s) => s && SKILLS[s.skill]).slice(0, 3);
  d.say = Array.isArray(d.say) ? d.say.filter((s) => s && s.text) : [];
  d._usd = r.usd;
  return d;
}

// Apply side effects that touch shared state (tasks, votes).
export function applyCivics(agentName, d) {
  const db = openDb();
  const out = [];
  const t = d.task || {};
  if (t.create?.title) { db.prepare("INSERT INTO tasks(title,detail,status,created_by,created_ts) VALUES(?,?,'open',?,?)").run(String(t.create.title).slice(0, 100), String(t.create.detail || '').slice(0, 300), agentName, now()); out.push(`posted task '${t.create.title}'`); }
  if (t.claim) { const r = db.prepare("UPDATE tasks SET status='claimed', claimed_by=?, claimed_ts=? WHERE id=? AND status='open'").run(agentName, now(), t.claim); if (r.changes) out.push(`claimed task #${t.claim}`); }
  if (t.done) { const r = db.prepare("UPDATE tasks SET status='done', done_ts=? WHERE id=? AND claimed_by=?").run(now(), t.done, agentName); if (r.changes) out.push(`finished task #${t.done}`); }
  if (t.release) { db.prepare("UPDATE tasks SET status='open', claimed_by=NULL WHERE id=? AND claimed_by=?").run(t.release, agentName); }
  const v = d.vote || {};
  if (v.propose?.question && Array.isArray(v.propose.options) && v.propose.options.length >= 2) {
    const hours = Math.min(Math.max(Number(v.propose.hours) || 24, 1), 72);
    db.prepare('INSERT INTO votes(question,options,opened_by,opened_ts,closes_ts) VALUES(?,?,?,?,?)').run(String(v.propose.question).slice(0, 200), JSON.stringify(v.propose.options.slice(0, 5)), agentName, now(), now() + hours * 3600_000);
    out.push(`opened a vote: ${v.propose.question}`);
  }
  if (v.cast?.vote_id && v.cast.option) {
    db.prepare('INSERT INTO ballots(vote_id,agent,option,reason,ts) VALUES(?,?,?,?,?) ON CONFLICT(vote_id,agent) DO UPDATE SET option=excluded.option, reason=excluded.reason, ts=excluded.ts')
      .run(v.cast.vote_id, agentName, String(v.cast.option).slice(0, 80), String(v.cast.reason || '').slice(0, 200), now());
    out.push(`voted '${v.cast.option}' on #${v.cast.vote_id}`);
  }
  return out;
}
