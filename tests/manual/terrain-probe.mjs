import mineflayer from 'mineflayer';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'PathTest', version: '1.21.4', auth: 'offline' });
bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const p = bot.entity.position.floored();
  const counts = {};
  for (let dx = -24; dx <= 24; dx++) for (let dz = -24; dz <= 24; dz++) for (let dy = -6; dy <= 6; dy++) {
    const b = bot.blockAt(p.offset(dx, dy, dz)); if (b && b.name !== 'air') counts[b.name] = (counts[b.name] || 0) + 1;
  }
  console.log('pos', p.toString(), 'biome', bot.blockAt(p)?.biome?.name);
  console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(' '));
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    await bot.look(yaw, 0, true);
    const s = bot.entity.position.clone(); bot.setControlState('forward', true); bot.setControlState('jump', true);
    await new Promise((r) => setTimeout(r, 2500)); bot.clearControlStates();
    const ahead = bot.blockAt(bot.entity.position.offset(-Math.sin(yaw), 0, -Math.cos(yaw)).floored());
    console.log(`yaw ${yaw.toFixed(2)} moved ${bot.entity.position.distanceTo(s).toFixed(1)} onGround=${bot.entity.onGround} ahead=${ahead?.name} vel=${bot.entity.velocity.toString()}`);
  }
  bot.quit(); process.exit(0);
});
setTimeout(() => process.exit(1), 30000);
