// Manual check: snapshot the surface around a bot on the dev server and render the Chronicle map.
// Usage: AGENTCRAFT_DATA_DIR=<scratch dir> node tests/manual/map-test.mjs <out.png>
import { writeFileSync } from 'node:fs';
import mineflayer from 'mineflayer';
import { openDb, now } from '../../agents/lib/db.js';
import { snapshotSurface } from '../../agents/lib/mapdata.js';
import { renderDayMap } from '../../ops/map.js';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username: 'MapTest', version: '1.21.4', auth: 'offline' });
bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 5000)); // let chunks arrive
  const t0 = Date.now(); const n = snapshotSurface(bot); console.log(`snapshot: ${n} chunks in ${Date.now() - t0} ms`);
  const db = openDb(); const p = bot.entity.position;
  const day = 'test-day';
  db.prepare('DELETE FROM map_tracks WHERE day=?').run(day);
  const walk = (agent, pts) => pts.forEach(([dx, dz], i) => db.prepare('INSERT INTO map_tracks(agent,day,ts,x,z) VALUES(?,?,?,?,?)').run(agent, day, now() + i, Math.round(p.x + dx), Math.round(p.z + dz)));
  walk('mags', [[0, 0], [10, 5], [25, 12], [30, 30]]); walk('tobin', [[0, 0], [-20, 10], [-35, -5]]); walk('wren', [[5, -5], [20, -30], [45, -40]]);
  for (const [name, kind, dx, dz] of [['base', 'base', 0, 0], ['ridge iron', 'ore', 45, -40], ['Sunspire Shelter', 'build', -35, -5]])
    db.prepare('INSERT INTO pois(name,kind,x,y,z,found_by,ts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO NOTHING').run(name, kind, Math.round(p.x + dx), 64, Math.round(p.z + dz), 'Test', now());
  const m = renderDayMap(day);
  writeFileSync(process.argv[2], m.png); console.log(`map ${m.size}px, ${m.png.length} bytes\n${m.legend}`);
  bot.quit(); process.exit(0);
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, 60000);
