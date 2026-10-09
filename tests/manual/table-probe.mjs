import mineflayer from 'mineflayer';
import { execSync } from 'node:child_process';
const V = process.env.V || '1.21.11';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'CraftTest', version: V, auth: 'offline' });
const rc = (c) => execSync(`docker exec mc-dev rcon-cli "${c}"`).toString().trim();
bot.on('windowOpen', (w) => console.log('windowOpen', w.type, w.title));
bot.once('spawn', async () => {
  rc('clear CraftTest'); rc('give CraftTest oak_planks 8'); rc('give CraftTest stick 4');
  const p = bot.entity.position.floored();
  rc(`setblock ${p.x + 2} ${p.y} ${p.z} crafting_table`);
  await new Promise((r) => setTimeout(r, 1500));
  const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 });
  const r = bot.recipesFor(bot.registry.itemsByName.wooden_axe.id, null, 1, table)[0];
  console.log('table', !!table, 'recipe', !!r);
  try { await bot.craft(r, 1, table); console.log('craft resolved'); } catch (e) { console.log('craft error', e.message); }
  await new Promise((res) => setTimeout(res, 1500));
  console.log('server:', rc('data get entity CraftTest Inventory').replace(/minecraft:/g, '').slice(30, 300));
  bot.quit(); process.exit(0);
});
setTimeout(() => process.exit(1), 40000);
