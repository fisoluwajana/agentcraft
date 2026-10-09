// Manual check: collect stone and coal with a stone pickaxe against the dev server on :25566 (1.21.4).
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import toolPlugin from 'mineflayer-tool';
import { execSync } from 'node:child_process';
import { SKILLS, setupMovements } from '../../agents/src/skills.js';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'CollectTest', version: '1.21.4', auth: 'offline' });
bot.loadPlugin(pf.pathfinder); bot.loadPlugin(toolPlugin.plugin);
const rc = (c) => execSync(`docker exec mc-seed rcon-cli "${c}"`).toString();
bot.once('spawn', async () => {
  setupMovements(bot); rc('whitelist off'); rc('tp CollectTest 44 66 96'); rc('clear CollectTest'); rc('give CollectTest stone_pickaxe 1');
  await new Promise((r) => setTimeout(r, 1500));
  for (const [block, count] of [['stone', 6], ['coal_ore', 3], ['iron_ore', 2]]) {
    const t = Date.now();
    try { const r = await SKILLS.collect.run(bot, { block, count }); console.log('OK', block, r.summary, `${((Date.now() - t) / 1000).toFixed(0)}s`); }
    catch (e) { console.log('FAIL', block, e.message, `${((Date.now() - t) / 1000).toFixed(0)}s`); }
  }
  bot.quit(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 300000);
