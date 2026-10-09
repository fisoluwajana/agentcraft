// Per-agent memory on disk: episodic log (jsonl), compact notes, goals, relationships.
// Raw logs never go into prompts; only the summarised notes and the last few events do.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { chat } from '../lib/llm.js';

export class Memory {
  constructor(agentId, persona) {
    this.id = agentId;
    this.persona = persona;
    this.dir = path.join(config.dataDir, 'agents', agentId);
    mkdirSync(this.dir, { recursive: true });
    this.recent = [];
    this.sinceSummary = 0;
  }

  file(n) { return path.join(this.dir, n); }
  readJson(n, fallback) { try { return JSON.parse(readFileSync(this.file(n), 'utf8')); } catch { return fallback; } }
  writeJson(n, v) { writeFileSync(this.file(n), JSON.stringify(v, null, 2)); }

  remember(kind, text) {
    const e = { ts: Date.now(), kind, text: String(text).slice(0, 300) };
    appendFileSync(this.file('episodic.jsonl'), JSON.stringify(e) + '\n');
    this.recent.push(e);
    if (this.recent.length > 40) this.recent.shift();
    this.sinceSummary++;
  }

  recentText(n = 8) {
    return this.recent.slice(-n).map((e) => `- ${e.kind}: ${e.text}`).join('\n') || '- (nothing yet)';
  }

  get notes() { return existsSync(this.file('notes.md')) ? readFileSync(this.file('notes.md'), 'utf8') : ''; }

  get goals() { return this.readJson('goals.json', null) ?? this.persona.startingGoals.map((g) => ({ goal: g, status: 'open' })); }
  set goals(v) { this.writeJson('goals.json', v.slice(0, 8)); }

  get relationships() { return this.readJson('relationships.json', {}); }

  updateRelationship(other, change) {
    if (!other || !change) return;
    const rel = this.relationships;
    const r = rel[other] || { opinion: 0, notes: [], debts: [], jokes: [] };
    if (typeof change.opinion_delta === 'number') r.opinion = Math.max(-5, Math.min(5, r.opinion + Math.max(-2, Math.min(2, change.opinion_delta))));
    for (const k of ['notes', 'debts', 'jokes']) if (change[k]) r[k] = [...r[k], String(change[k]).slice(0, 140)].slice(-5);
    rel[other] = r;
    this.writeJson('relationships.json', rel);
  }

  relationshipsText(names) {
    const rel = this.relationships;
    return names.map((n) => {
      const r = rel[n.toLowerCase()] || rel[n];
      if (!r) return `- ${n}: no strong opinion yet`;
      return `- ${n}: opinion ${r.opinion > 0 ? '+' : ''}${r.opinion}/5${r.notes.length ? `; ${r.notes.slice(-2).join('; ')}` : ''}${r.debts.length ? `; debts: ${r.debts.slice(-2).join('; ')}` : ''}${r.jokes.length ? `; running joke: ${r.jokes.at(-1)}` : ''}`;
    }).join('\n');
  }

  // Fold recent events into notes with the cheap utility model, flex tier. Called occasionally.
  async summarise(force = false) {
    if (!force && this.sinceSummary < 30) return;
    const role = config.roles.utility;
    const tail = readFileSync(this.file('episodic.jsonl'), 'utf8').trim().split('\n').slice(-60).map((l) => { try { const e = JSON.parse(l); return `${e.kind}: ${e.text}`; } catch { return ''; } }).join('\n');
    const r = await chat({
      agent: this.id, callType: 'memory_summary', model: role.model, tier: role.tier, maxTokens: role.maxTokens, temperature: 0.3,
      messages: [
        { role: 'system', content: `You maintain ${this.persona.name}'s private notes about a Minecraft world: facts that matter later (places with coordinates, who owes what, what's built, open problems, promises). Max 180 words, terse bullet points, first person. No fluff.` },
        { role: 'user', content: `Current notes:\n${this.notes || '(none)'}\n\nNew events:\n${tail}\n\nRewrite the notes.` },
      ],
    });
    if (r.text?.trim()) { writeFileSync(this.file('notes.md'), r.text.trim().slice(0, 1600)); this.sinceSummary = 0; }
  }
}
