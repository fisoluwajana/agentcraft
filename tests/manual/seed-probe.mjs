// Scores the area around spawn: surface height spread, trees, water. Lower spread = easier pathing.
import mineflayer from 'mineflayer';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'SeedProbe', version: '1.21.4', auth: 'offline' });
bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 6000));
  const p = bot.entity.position.floored();
  const heights = []; let logs = 0, water = 0, leaves = 0;
  for (let dx = -48; dx <= 48; dx += 4) for (let dz = -48; dz <= 48; dz += 4) {
    for (let y = 160; y > 40; y--) {
      const b = bot.blockAt(p.offset(dx, y - p.y, dz));
      if (!b) break;
      if (b.name === 'air' || b.name === 'cave_air' || b.name.includes('grass') && b.boundingBox === 'empty' || b.name.endsWith('flowers')) continue;
      if (b.name.endsWith('_leaves')) { leaves++; continue; }
      if (b.name.endsWith('_log')) { logs++; continue; }
      if (b.name === 'water') water++;
      heights.push(y); break;
    }
  }
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const sd = Math.sqrt(heights.reduce((a, b) => a + (b - mean) ** 2, 0) / heights.length);
  console.log(JSON.stringify({ spawn: p.toString(), surfaceSd: +sd.toFixed(1), meanY: Math.round(mean), logs, leaves, water, samples: heights.length }));
  bot.quit(); process.exit(0);
});
setTimeout(() => { console.log('{"error":"timeout"}'); process.exit(1); }, 60000);
