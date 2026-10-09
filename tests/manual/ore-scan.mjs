import mineflayer from 'mineflayer';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'CollectTest', version: '1.21.4', auth: 'offline' });
bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 3000));
  const me = bot.entity.position;
  for (const n of ['coal_ore', 'iron_ore', 'stone']) {
    const ps = bot.findBlocks({ matching: bot.registry.blocksByName[n].id, maxDistance: 24, count: 200 }).filter((p) => p.y - me.y <= 1 && me.y - p.y <= 12);
    console.log(n, 'pos', me.floored().toString(), 'found', ps.length, 'ys', [...new Set(ps.map((p) => p.y))].sort((a,b)=>a-b).slice(0,20).join(','));
  }
  bot.quit(); process.exit(0);
});
