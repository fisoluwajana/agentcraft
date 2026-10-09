// Bedrock "mantle" client (OpenAI-compatible chat completions, SigV4-signed),
// with budget enforcement and per-call cost accounting.
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { config, modelPrice } from './config.js';
import { openDb, now } from './db.js';
import { seasonDay, monthKey, sleep } from './time.js';
import { checkBudget, BudgetExceeded } from './budget.js';

const url = new URL(config.mantleEndpoint);
const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: config.region,
  service: 'bedrock-mantle',
  sha256: Sha256,
});

export function estimateTokens(messages) {
  const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  return Math.ceil(chars / 3.6);
}

function record({ agent, callType, model, tier, inTok, outTok, ok }) {
  const p = modelPrice(model, tier);
  const usd = (inTok * p.in + outTok * p.out) / 1e6;
  openDb().prepare(`INSERT INTO llm_usage(ts,day,month,agent,call_type,model,tier,in_tokens,out_tokens,usd,ok)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(now(), seasonDay(), monthKey(), agent, callType, model, tier, inTok, outTok, usd, ok ? 1 : 0);
  return usd;
}

async function post(body) {
  const payload = JSON.stringify(body);
  const req = new HttpRequest({
    method: 'POST', protocol: 'https:', hostname: url.hostname, path: url.pathname,
    headers: { host: url.hostname, 'content-type': 'application/json' }, body: payload,
  });
  const signed = await signer.sign(req);
  const res = await fetch(url, { method: 'POST', headers: signed.headers, body: payload, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`mantle ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * chat({agent, callType, model, tier, messages, maxTokens, json}) -> {text, usage, usd}
 * Throws BudgetExceeded when the call isn't allowed.
 */
export async function chat({ agent, callType, model, tier = 'default', messages, maxTokens = 600, json = false, temperature = 0.8 }) {
  const est = estimateTokens(messages) + maxTokens;
  checkBudget({ agent, estTokens: est, model, tier });

  const m = config.models[model] || {};
  const body = { model, messages, max_tokens: maxTokens, temperature };
  if (tier === 'flex') body.service_tier = 'flex';
  if (m.reasoning) body.reasoning_effort = 'low';
  // mantle's json_object mode produced degenerate output for gpt-oss (2026-10-09); rely on the prompt + parseJsonLoose.
  if (json && m.jsonMode) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await post(body);
      const usage = r.usage || {};
      const inTok = usage.prompt_tokens ?? estimateTokens(messages);
      const outTok = usage.completion_tokens ?? 0;
      const msg = r.choices?.[0]?.message || {};
      const usd = record({ agent, callType, model, tier, inTok, outTok, ok: true });
      return { text: msg.content ?? '', reasoning: msg.reasoning, finish: r.choices?.[0]?.finish_reason, usage: { inTok, outTok }, usd };
    } catch (e) {
      lastErr = e;
      // Some models reject response_format or service_tier; retry once without them.
      if (e.status === 400 && (body.response_format || body.service_tier)) {
        delete body.response_format; delete body.service_tier; continue;
      }
      if (e.status && e.status < 500 && e.status !== 429) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  record({ agent, callType, model, tier, inTok: 0, outTok: 0, ok: false });
  throw lastErr;
}

// Pull the first JSON object out of a model reply (handles ```json fences and chatter).
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = fenced ? fenced[1] : text;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export { BudgetExceeded };
