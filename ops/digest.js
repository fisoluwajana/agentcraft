// Weekly #ops health digest: spend vs budget, per agent / call type / day, progress,
// errors, and the top 3 cost drivers with a concrete suggestion for each.
import { config } from '../agents/lib/config.js';
import { openDb, now } from '../agents/lib/db.js';
import { ops } from '../agents/lib/discord.js';

const SUGGEST = {
  decide: 'raise minSecondsBetweenAgentCalls or lower chattiness so fewer events trigger a decision; trim chat history in the prompt from 10 to 6 lines',
  memory_summary: 'summarise every 50 events instead of 30',
  chronicle: 'cap the chat sample at 60 lines',
  weekly_recap: 'only feed the last 5 chronicles',
  planner: 'plan once per session instead of on every wake',
};

export function digestData(sinceMs = now() - 7 * 86400_000) {
  const db = openDb();
  const total = db.prepare('SELECT COALESCE(SUM(usd),0) usd, COUNT(*) calls, COALESCE(SUM(in_tokens),0) i, COALESCE(SUM(out_tokens),0) o FROM llm_usage WHERE ts>?').get(sinceMs);
  const byAgent = db.prepare('SELECT agent, ROUND(SUM(usd),4) usd, COUNT(*) calls FROM llm_usage WHERE ts>? GROUP BY agent ORDER BY usd DESC').all(sinceMs);
  const byType = db.prepare('SELECT call_type, model, ROUND(SUM(usd),4) usd, COUNT(*) calls, ROUND(AVG(in_tokens)) avg_in, ROUND(AVG(out_tokens)) avg_out FROM llm_usage WHERE ts>? GROUP BY call_type, model ORDER BY usd DESC').all(sinceMs);
  const byDay = db.prepare('SELECT day, ROUND(SUM(usd),4) usd FROM llm_usage WHERE ts>? GROUP BY day ORDER BY day').all(sinceMs);
  const progress = db.prepare("SELECT agent, COUNT(*) n FROM events WHERE ts>? AND kind='progress' GROUP BY agent").all(sinceMs);
  const posts = db.prepare("SELECT author, COUNT(*) n FROM chat WHERE ts>? AND kind='message' GROUP BY author").all(sinceMs);
  const incidents = db.prepare("SELECT kind, COUNT(*) n FROM events WHERE ts>? AND kind IN ('death','watchdog','budget_sleep') GROUP BY kind").all(sinceMs);
  const failed = db.prepare('SELECT COUNT(*) n FROM llm_usage WHERE ts>? AND ok=0').get(sinceMs).n;
  return { total, byAgent, byType, byDay, progress, posts, incidents, failed };
}

export async function weeklyDigest() {
  const d = digestData();
  const weeklyBudget = (config.budgets.monthlyLlmUsd * 7) / 30;
  const top3 = d.byType.slice(0, 3).map((t, i) => `${i + 1}. \`${t.call_type}\` on ${t.model}: $${t.usd} (${t.calls} calls, avg ${t.avg_in} in / ${t.avg_out} out). → ${SUGGEST[t.call_type] || 'review how often this runs'}`);
  const lines = [
    '📊 **Weekly health digest**',
    `LLM spend: **$${d.total.usd.toFixed(2)}** of ~$${weeklyBudget.toFixed(2)} weekly share (${d.total.calls} calls, ${d.total.i} in / ${d.total.o} out tokens, ${d.failed} failed)`,
    `Per agent: ${d.byAgent.map((a) => `${a.agent} $${a.usd} (${a.calls})`).join(' · ') || '-'}`,
    `Per day: ${d.byDay.map((x) => `${x.day.slice(5)} $${x.usd}`).join(' · ') || '-'}`,
    `Progress events: ${d.progress.map((p) => `${p.agent} ${p.n}`).join(' · ') || '-'} | Posts: ${d.posts.map((p) => `${p.author} ${p.n}`).join(' · ') || '-'}`,
    `Incidents: ${d.incidents.map((x) => `${x.kind} ${x.n}`).join(' · ') || 'none'}`,
    '**Top cost drivers**', ...top3,
  ];
  await ops(lines.join('\n'));
  return d;
}
