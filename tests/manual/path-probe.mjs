// Pathfinding probe: walk 30 blocks in each direction with canDig on/off; report time, success, heap.
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
const { goals, Movements } = pf;
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: 'PathTest', version: '1.21.4', auth: 'offline' });
bot.loadPlugin(pf.pathfinder);
const stats = {};
const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
bot.on('path_update', (r) => bump(`update:${r.status}:${r.path.length > 0 ? 'len' : 'empty'}`));
bot.on('path_reset', (reason) => bump(`reset:${reason}`));
bot.on('path_stop', () => bump('stop'));
const t = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 2000));
  for (const dig of [true]) {
    const m = new Movements(bot); m.canDig = dig; m.allow1by1towers = true; m.allowParkour = true; m.maxDropDown = 4;
    bot.pathfinder.setMovements(m); bot.pathfinder.searchRadius = 96; bot.pathfinder.thinkTimeout = Number(process.env.THINK || 6000); bot.pathfinder.tickTimeout = Number(process.env.TICK || 30);
    for (const [dx, dz] of [[30, 0], [0, 30], [-30, 0], [0, -30]]) {
      const s = bot.entity.position.clone(); const t0 = Date.now();
      let res = 'ok'; bot.pathfinder.setGoal(null); await new Promise((r) => setTimeout(r, 250));
      try { await t(bot.pathfinder.goto(new goals.GoalNearXZ(s.x + dx, s.z + dz, 3)), 45000); } catch (e) { res = e.message.slice(0, 40); bot.pathfinder.stop(); }
      console.log(`dig=${dig} dir=${dx},${dz} ${res} moved=${Math.round(bot.entity.position.distanceTo(s))} t=${((Date.now() - t0) / 1000).toFixed(1)}s heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}MB y=${Math.round(bot.entity.position.y)} ${JSON.stringify(stats)}`);
      for (const k of Object.keys(stats)) delete stats[k];
    }
  }
  bot.quit(); process.exit(0);
});
setTimeout(() => process.exit(1), 420000);
