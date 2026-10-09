// The Chronicler: a story-style recap of each day, posted to #the-chronicle after the
// session ends. Uses the narrator model on the discounted "flex" tier (not real-time).
import { config } from '../agents/lib/config.js';
import { openDb } from '../agents/lib/db.js';
import { chat } from '../agents/lib/llm.js';
import { postAs } from '../agents/lib/discord.js';
import { renderDayMap } from '../ops/map.js';

const CHRONICLER = { username: 'The Chronicler', avatarUrl: 'https://api.dicebear.com/9.x/pixel-art/png?seed=TheChronicler&size=128' };

const STYLE = `You are The Chronicler, the dry, warm, slightly theatrical historian of a small Minecraft settlement whose only inhabitants are its builders. You write the evening paper.
Rules: only use facts from the material given; never invent events, items, places or quotes. Quote the inhabitants' own words when they're good. Name rivalries, grudges and small kindnesses. PG and friendly: tease, never wound.
Format for Discord: a bold headline, then 3-6 short paragraphs, then a one-line "Tomorrow:" teaser based on open tasks, votes or unresolved tension. Max 1700 characters. No hashtags.`;

function dayMaterial(day) {
  const db = openDb();
  const events = db.prepare("SELECT agent, kind, data FROM events WHERE day=? AND kind IN ('progress','discovery','death','vote_closed','watchdog','budget_sleep') ORDER BY ts").all(day);
  const chatRows = db.prepare("SELECT channel, author, text FROM chat WHERE day=? AND kind IN ('message','system') ORDER BY id").all(day);
  const tasks = db.prepare("SELECT title,status,claimed_by FROM tasks WHERE status IN ('open','claimed') LIMIT 8").all();
  const votes = db.prepare("SELECT question,status,result FROM votes ORDER BY id DESC LIMIT 5").all();
  // Keep the material compact: sample chat if long.
  const chatLines = chatRows.length > 120 ? [...chatRows.slice(0, 40), ...chatRows.filter((_, i) => i % 3 === 0).slice(13, 53), ...chatRows.slice(-40)] : chatRows;
  return [
    `EVENTS:\n${events.map((e) => `- ${e.agent || 'world'} ${e.kind}: ${(() => { try { const d = JSON.parse(e.data); return d.text || d.kind || d.question || JSON.stringify(d); } catch { return e.data; } })()}`).join('\n') || '- (quiet day)'}`,
    `CHAT:\n${chatLines.map((c) => `#${c.channel} ${c.author}: ${c.text}`).join('\n') || '(nobody spoke)'}`,
    `OPEN TASKS: ${tasks.map((t) => `${t.title} (${t.status}${t.claimed_by ? ` by ${t.claimed_by}` : ''})`).join('; ') || 'none'}`,
    `VOTES: ${votes.map((v) => `${v.question} [${v.status}${v.result ? `: ${v.result}` : ''}]`).join('; ') || 'none'}`,
  ].join('\n\n');
}

export async function runChronicle(day) {
  const material = dayMaterial(day);
  const role = config.roles.narrator;
  const r = await chat({
    agent: 'chronicler', callType: 'chronicle', model: role.model, tier: role.tier, maxTokens: role.maxTokens, temperature: 0.9,
    messages: [{ role: 'system', content: STYLE }, { role: 'user', content: `Write the Chronicle for ${day}.\n\n${material}` }],
  });
  const text = (r.text || '').trim();
  if (!text) throw new Error('narrator returned nothing');
  openDb().prepare("INSERT INTO chat(ts,day,channel,author,text,kind) VALUES(?,?,?,?,?,'chronicle')").run(Date.now(), day, 'the-chronicle', CHRONICLER.username, text);
  await postAs({ channel: config.discord.chronicleChannel, ...CHRONICLER, content: text });
  // The day's map goes underneath as its own post (image + numbered legend). Never fails the Chronicle.
  try {
    const map = renderDayMap(day);
    if (map) await postAs({ channel: config.discord.chronicleChannel, ...CHRONICLER, content: map.legend, files: [{ name: `map-${day}.png`, data: map.png, type: 'image/png' }] });
  } catch (e) { console.error('[chronicle] map failed:', e.message); }
  return { usd: r.usd, chars: text.length };
}

export async function runWeeklyRecap(day) {
  const db = openDb();
  const chronicles = db.prepare("SELECT day, text FROM chat WHERE kind='chronicle' ORDER BY id DESC LIMIT 7").all().reverse();
  if (!chronicles.length) return;
  const role = config.roles.narrator;
  const r = await chat({
    agent: 'chronicler', callType: 'weekly_recap', model: role.model, tier: role.tier, maxTokens: role.maxTokens, temperature: 0.9,
    messages: [
      { role: 'system', content: `${STYLE}\nThis is the longer weekly season recap: the arc of the week, who rose, who fell out, what got built, what's unresolved. Max 1900 characters.` },
      { role: 'user', content: chronicles.map((c) => `== ${c.day} ==\n${c.text}`).join('\n\n') },
    ],
  });
  const text = `📖 **Season recap, week ending ${day}**\n\n${(r.text || '').trim()}`.slice(0, 1990);
  await postAs({ channel: config.discord.chronicleChannel, ...CHRONICLER, content: text });
}
