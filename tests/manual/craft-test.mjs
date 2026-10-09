// Manual check: inventory crafting and crafting-table crafting against the dev server.
// Usage: node tests/manual/craft-test.mjs   (needs mc-dev on 127.0.0.1, whitelist off)
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import toolPlugin from 'mineflayer-tool';
import { execSync } from 'node:child_process';
import { SKILLS, setupMovements } from '../../agents/src/skills.js';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'CraftTest', version: '1.21.4', auth: 'offline' });
bot.loadPlugin(pf.pathfinder); bot.loadPlugin(toolPlugin.plugin);
const inv = () => bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(',');
bot.once('spawn', async () => {
  console.log('spawned');
  setupMovements(bot); console.log('movements ok');
  execSync('docker exec mc-dev rcon-cli "clear CraftTest"'); execSync('docker exec mc-dev rcon-cli "give CraftTest oak_log 6"');
  await new Promise((r) => setTimeout(r, 1500));
  for (const item of ['crafting_table', 'wooden_axe', 'wooden_pickaxe']) {
    try { const r = await SKILLS.craft.run(bot, { item, count: 1 }); console.log('OK', item, r.summary, '|', inv()); }
    catch (e) { console.log('FAIL', item, e.message, '|', inv()); }
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('bot view:', inv());
  console.log('server view:', execSync('docker exec mc-dev rcon-cli "data get entity CraftTest Inventory"').toString().replace(/minecraft:/g, '').slice(0, 400));
  bot.quit(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 90000);
