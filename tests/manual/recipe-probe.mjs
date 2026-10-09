import mineflayer from 'mineflayer';
import { execSync } from 'node:child_process';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'CraftTest', version: '1.21.4', auth: 'offline' });
bot.once('spawn', async () => {
  execSync('docker exec mc-dev rcon-cli "clear CraftTest"'); execSync('docker exec mc-dev rcon-cli "give CraftTest oak_planks 8"'); execSync('docker exec mc-dev rcon-cli "give CraftTest stick 4"');
  await new Promise((r) => setTimeout(r, 1500));
  const axe = bot.registry.itemsByName.wooden_axe.id;
  const noTable = bot.recipesFor(axe, null, 1, null);
  const all = bot.recipesAll(axe, null, true);
  console.log('recipesFor(no table):', noTable.length, noTable.map((r) => r.requiresTable));
  console.log('recipesAll(table):', all.length, all.map((r) => r.requiresTable));
  bot.quit(); process.exit(0);
});
setTimeout(() => process.exit(1), 30000);
