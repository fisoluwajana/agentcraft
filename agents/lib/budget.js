// Hard spending limits, enforced before every LLM call.
import { config, modelPrice } from './config.js';
import { openDb, kvGet } from './db.js';
import { seasonDay, monthKey } from './time.js';

export class BudgetExceeded extends Error {
  constructor(scope, detail) { super(`${scope} budget exceeded: ${detail}`); this.scope = scope; }
}

export function spend({ agent, day = seasonDay(), month = monthKey() } = {}) {
  const db = openDb();
  const m = db.prepare('SELECT COALESCE(SUM(usd),0) usd FROM llm_usage WHERE month=?').get(month);
  const out = { monthUsd: m.usd };
  if (agent) {
    const d = db.prepare('SELECT COALESCE(SUM(usd),0) usd, COALESCE(SUM(in_tokens+out_tokens),0) tok, COUNT(*) calls FROM llm_usage WHERE day=? AND agent=?').get(day, agent);
    Object.assign(out, { dayUsd: d.usd, dayTokens: d.tok, dayCalls: d.calls });
  }
  return out;
}

// Throws BudgetExceeded; returns nothing when the call may proceed.
export function checkBudget({ agent, estTokens = 0, model, tier = 'default' }) {
  const pause = kvGet('pause');
  if (pause) throw new BudgetExceeded('global', `paused (${pause.reason || 'manual'})`);

  const b = config.budgets;
  const est = model ? (estTokens * modelPrice(model, tier).out) / 1e6 : 0;
  const s = spend({ agent });
  if (s.monthUsd + est > b.monthlyLlmUsd) throw new BudgetExceeded('global', `month $${s.monthUsd.toFixed(2)} of $${b.monthlyLlmUsd}`);

  const isAgent = config.agents.some((a) => a.id === agent);
  if (isAgent) {
    if (s.dayUsd + est > b.perAgentDailyUsd) throw new BudgetExceeded('agent', `${agent} day $${s.dayUsd.toFixed(3)} of $${b.perAgentDailyUsd}`);
    if (s.dayTokens + estTokens > b.perAgentDailyTokens) throw new BudgetExceeded('agent', `${agent} day ${s.dayTokens} tokens of ${b.perAgentDailyTokens}`);
  }
}
