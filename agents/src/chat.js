// Chat layer: reads the shared conversation from SQLite, decides who answers,
// and posts to Discord with human-like pacing and hard caps. Silence is free.
import { openDb, now } from '../lib/db.js';
import { config } from '../lib/config.js';
import { seasonDay, sleep } from '../lib/time.js';
import { postAs, react, startThread } from '../lib/discord.js';

const BANNED_DEFAULT = ['as an ai', 'great work team', 'absolutely', "let's collaborate", 'synergy', "i'd be happy to"];

export class Chat {
  constructor(agentId, persona) {
    this.id = agentId;
    this.persona = persona;
    this.name = persona.name;
    this.lastSeenId = openDb().prepare('SELECT COALESCE(MAX(id),0) m FROM chat').get().m;
    this.queue = Promise.resolve();
    this.banned = [...BANNED_DEFAULT, ...(persona.never || []).map((s) => s.toLowerCase())];
  }

  // New messages from others since we last looked.
  unread() {
    const rows = openDb().prepare('SELECT * FROM chat WHERE id>? AND author<>? ORDER BY id').all(this.lastSeenId, this.name);
    if (rows.length) this.lastSeenId = rows.at(-1).id;
    return rows;
  }

  recent(n = 10, channel = null) {
    const q = channel
      ? openDb().prepare('SELECT * FROM chat WHERE channel=? ORDER BY id DESC LIMIT ?').all(channel, n)
      : openDb().prepare("SELECT * FROM chat WHERE kind='message' ORDER BY id DESC LIMIT ?").all(n);
    return q.reverse();
  }

  // Recent lines per world channel (most recent channels first), so side conversations stay visible.
  recentAcross(perChannel = { general: 7, 'off-topic': 4, builds: 3, 'town-hall': 4 }) {
    const out = [];
    for (const [c, n] of Object.entries(perChannel)) out.push(...this.recent(n, c).filter((m) => m.kind === 'message' || m.kind === 'system'));
    return out.sort((a, b) => a.id - b.id);
  }

  addressedToMe(msg) {
    const t = msg.text.toLowerCase();
    if (t.includes(this.name.toLowerCase()) || t.includes('everyone') || t.includes('@all')) return true;
    if (msg.reply_to) {
      const parent = openDb().prepare('SELECT author FROM chat WHERE id=?').get(msg.reply_to);
      if (parent?.author === this.name) return true;
    }
    return false;
  }

  postsLastHour() {
    return openDb().prepare("SELECT COUNT(*) n FROM chat WHERE author=? AND ts>? AND kind='message'").get(this.name, now() - 3600_000).n;
  }

  // Chat-vs-progress guardrail: if talking a lot while doing little, the cap tightens.
  postCap(progressEventsLastHour) {
    const base = config.discord.maxPostsPerAgentPerHour;
    if (progressEventsLastHour === 0) return Math.max(4, Math.floor(base / 2));
    if (progressEventsLastHour < 3) return Math.max(6, Math.floor(base * 0.7));
    return base;
  }

  // Catchphrase cooldown: if a catchphrase appeared in our last few messages, strip it from the
  // start of this one (models love opening every message with the same signature line).
  stripRepeatedCatchphrase(t) {
    const phrases = (this.persona.catchphrases || []).map((c) => c.toLowerCase());
    if (!phrases.length) return t;
    const mine = openDb().prepare("SELECT text FROM chat WHERE author=? AND kind='message' ORDER BY id DESC LIMIT 8").all(this.name).map((r) => r.text.toLowerCase());
    for (const c of phrases) {
      const lead = new RegExp(`^\\s*${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,.:;!\\-–—]*`, 'i');
      if (lead.test(t) && mine.some((m) => m.includes(c))) {
        const rest = t.replace(lead, '').trim();
        if (rest.length > 3) return this.persona.typingStyle?.case?.includes('lowercase') ? rest : rest[0].toUpperCase() + rest.slice(1);
      }
    }
    return t;
  }

  clean(text) {
    let t = String(text || '').trim();
    t = this.stripRepeatedCatchphrase(t);
    t = t.replace(/^["'`]|["'`]$/g, '').replace(/^\s*\w+:\s*/, (m) => (m.toLowerCase().startsWith(this.name.toLowerCase()) ? '' : m));
    for (const b of this.banned) if (b && t.toLowerCase().includes(b)) return null;
    if (/[*_]{0,2}(as an ai|language model)/i.test(t)) return null;
    return t.slice(0, 600);
  }

  /**
   * Post one or more lines. Each item: {channel, text, reply_to_id?, react?:{message_id, emoji}, thread?:"name"}
   * Returns the number actually posted.
   */
  async say(items, progressEventsLastHour) {
    let posted = 0;
    const cap = this.postCap(progressEventsLastHour);
    for (const it of items.slice(0, 4)) {
      if (it.react?.message_id) { await this.reactTo(it.react.message_id, it.react.emoji); continue; }
      let channel = config.discord.worldChannels.includes(it.channel) ? it.channel : 'general';
      const civicTalk = /\bvot(e|es|ed|ing)\b|\bpropos|\bmayor\b|\belect|\bdecid|\bshould we\b|\bmotion\b|\bballot/i.test(it.text || '');
      const openVote = openDb().prepare("SELECT COUNT(*) n FROM votes WHERE status='open'").get().n > 0;
      if (it.civic || (civicTalk && openVote)) channel = 'town-hall';
      // #town-hall is only for decisions: anything else posted there moves to #general.
      else if (channel === 'town-hall' && !civicTalk) channel = 'general';
      const text = this.clean(it.text);
      if (!text || this.isRepeat(text)) continue;
      if (it.reply_to_id && openDb().prepare('SELECT author FROM chat WHERE id=?').get(it.reply_to_id)?.author === this.name) it.reply_to_id = null;
      if (this.postsLastHour() >= cap) break;
      // Human pacing: think, then type.
      const typing = Math.min(text.length / config.discord.typingCharsPerSecond, 14);
      await sleep((config.discord.minGapSeconds + Math.random() * 4 + typing) * 1000);
      const day = seasonDay();
      let threadId = null;
      if (it.reply_to_id) {
        const parent = openDb().prepare('SELECT * FROM chat WHERE id=?').get(it.reply_to_id);
        if (parent?.thread) threadId = parent.thread;
      }
      const res = openDb().prepare('INSERT INTO chat(ts,day,channel,author,text,reply_to,thread) VALUES(?,?,?,?,?,?,?)')
        .run(now(), day, channel, this.name, text, it.reply_to_id || null, threadId);
      const rowId = Number(res.lastInsertRowid);
      let content = text;
      if (it.reply_to_id && !threadId) {
        const parent = openDb().prepare('SELECT author,text FROM chat WHERE id=?').get(it.reply_to_id);
        if (parent) content = `> **${parent.author}:** ${parent.text.slice(0, 80)}${parent.text.length > 80 ? '…' : ''}\n${text}`;
      }
      try {
        const did = await postAs({ channel, username: this.persona.name, avatarUrl: this.persona.avatarUrl, content, threadId });
        openDb().prepare('UPDATE chat SET discord_id=? WHERE id=?').run(did, rowId);
        if (it.thread) {
          const tid = await startThread({ channel, messageId: did, name: it.thread });
          openDb().prepare('UPDATE chat SET thread=? WHERE id=?').run(tid, rowId);
        }
      } catch (e) { console.error(`[${this.id}] discord post failed: ${e.message}`); }
      posted++;
    }
    return posted;
  }

  // Skip near-duplicates of anything we said in the last hour (word-set Jaccard similarity).
  isRepeat(text) {
    const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
    const a = words(text);
    if (a.size < 3) return false;
    const mine = openDb().prepare("SELECT text FROM chat WHERE author=? AND ts>? AND kind='message' ORDER BY id DESC LIMIT 12").all(this.name, now() - 3600_000);
    return mine.some(({ text: t }) => { const b = words(t); const inter = [...a].filter((w) => b.has(w)).length; return inter / (a.size + b.size - inter) > 0.55; });
  }

  async reactTo(chatId, emoji) {
    const m = openDb().prepare('SELECT * FROM chat WHERE id=?').get(chatId);
    if (!m?.discord_id || !emoji) return;
    try { await react({ channel: m.channel, messageId: m.discord_id, emoji: [...emoji][0] }); } catch { /* ignore */ }
  }
}
