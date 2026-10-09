// Loads config/agentcraft.json with environment overrides.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const raw = JSON.parse(readFileSync(path.join(ROOT, 'config/agentcraft.json'), 'utf8'));

export const config = {
  ...raw,
  dataDir: process.env.AGENTCRAFT_DATA_DIR || raw.dataDir,
  dryRunDiscord: process.env.DISCORD_DRY_RUN === '1',
  minecraft: {
    ...raw.minecraft,
    host: process.env.MC_HOST || raw.minecraft.host,
    port: Number(process.env.MC_PORT || raw.minecraft.port),
    rconPort: Number(process.env.RCON_PORT || raw.minecraft.rconPort),
    rconPassword: process.env.RCON_PASSWORD || '',
  },
};

export function agentConfig(id) {
  const a = config.agents.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown agent '${id}'. Known: ${config.agents.map((x) => x.id).join(', ')}`);
  const persona = JSON.parse(readFileSync(path.join(ROOT, a.persona), 'utf8'));
  return { ...a, persona };
}

export function modelPrice(model, tier = 'default') {
  const p = config.models[model];
  if (!p) throw new Error(`No price configured for model ${model}`);
  return tier === 'flex' ? { in: p.flexIn, out: p.flexOut } : { in: p.in, out: p.out };
}
