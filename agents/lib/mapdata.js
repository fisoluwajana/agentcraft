// Map data: agents record the top surface of the chunks around them and their own track, so ops
// can draw a top-down map of the village for the Chronicle without reading the world files.
import { openDb, now } from './db.js';

// Keyword -> RGB. First match wins; order matters (specific before general).
const PALETTE = [
  ['water', [52, 92, 196]], ['lava', [230, 110, 20]], ['ice', [150, 190, 250]], ['snow', [245, 248, 250]],
  ['leaves', [44, 110, 36]], ['grass_block', [96, 152, 60]], ['moss', [90, 140, 50]], ['short_grass', [96, 152, 60]], ['tall_grass', [96, 152, 60]], ['fern', [80, 140, 55]],
  ['sand', [219, 207, 150]], ['gravel', [136, 128, 124]], ['clay', [160, 166, 179]], ['mud', [60, 52, 48]],
  ['_log', [104, 82, 50]], ['_wood', [104, 82, 50]], ['planks', [176, 140, 86]], ['crafting_table', [140, 100, 60]], ['chest', [150, 110, 50]], ['furnace', [90, 90, 90]],
  ['torch', [255, 210, 80]], ['door', [150, 110, 60]], ['cobblestone', [110, 110, 110]], ['stone_bricks', [120, 120, 120]],
  ['coal_ore', [60, 60, 60]], ['iron_ore', [200, 160, 130]], ['_ore', [150, 150, 150]],
  ['stone', [128, 128, 128]], ['andesite', [136, 136, 136]], ['diorite', [190, 190, 190]], ['granite', [150, 110, 95]], ['deepslate', [80, 80, 85]], ['tuff', [100, 100, 95]],
  ['dirt', [134, 96, 67]], ['farmland', [110, 74, 48]], ['podzol', [100, 70, 40]], ['path', [148, 122, 72]],
  ['flower', [200, 80, 120]], ['poppy', [200, 40, 40]], ['dandelion', [230, 210, 60]], ['pumpkin', [220, 130, 30]], ['melon', [110, 160, 40]],
  ['wool', [220, 220, 220]], ['glass', [190, 220, 230]], ['bed', [180, 40, 40]],
];
const SKIP = new Set(['air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void']);
const colorCache = new Map();
export function blockColor(name) {
  if (!colorCache.has(name)) colorCache.set(name, (PALETTE.find(([k]) => name.includes(k)) || [null, [120, 120, 100]])[1]);
  return colorCache.get(name);
}
// Thin plants are drawn as the ground under them would be, except flowers and crops.
const SEE_THROUGH = /^(short_grass|tall_grass|fern|large_fern|dead_bush|vine|snow$|seagrass|tall_seagrass|kelp|kelp_plant|sugar_cane)/;

/** Record the surface (color + height) of chunks within `radius` chunks of the bot. ~1-2 s CPU. */
export function snapshotSurface(bot, radius = 5) {
  const reg = bot.registry;
  const me = bot.entity.position;
  const cx0 = Math.floor(me.x / 16), cz0 = Math.floor(me.z / 16);
  const top = Math.min(Math.floor(me.y) + 48, 319), bottom = Math.max(Math.floor(me.y) - 64, -60);
  const db = openDb();
  const put = db.prepare('INSERT INTO map_chunks(cx,cz,ts,rgb,height) VALUES(?,?,?,?,?) ON CONFLICT(cx,cz) DO UPDATE SET ts=excluded.ts, rgb=excluded.rgb, height=excluded.height');
  const pos = { x: 0, y: 0, z: 0 };
  let saved = 0;
  db.exec('BEGIN');
  try {
    for (let cx = cx0 - radius; cx <= cx0 + radius; cx++) for (let cz = cz0 - radius; cz <= cz0 + radius; cz++) {
      if (!bot.world.getColumn(cx, cz)) continue; // not loaded
      const rgb = Buffer.alloc(256 * 3), height = Buffer.alloc(256 * 2);
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        pos.x = cx * 16 + lx; pos.z = cz * 16 + lz;
        let c = [0, 0, 0], h = bottom;
        for (let y = top; y >= bottom; y--) {
          pos.y = y;
          const sid = bot.world.getBlockStateId(pos);
          const name = reg.blocksByStateId[sid]?.name;
          if (!name || SKIP.has(name) || SEE_THROUGH.test(name)) continue;
          c = blockColor(name); h = y; break;
        }
        const i = lz * 16 + lx;
        rgb.set(c, i * 3); height.writeInt16LE(h, i * 2);
      }
      put.run(cx, cz, now(), rgb, height); saved++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return saved;
}

export function recordTrack(agent, bot, day) {
  const p = bot.entity.position;
  openDb().prepare('INSERT INTO map_tracks(agent,day,ts,x,z) VALUES(?,?,?,?,?)').run(agent, day, now(), Math.round(p.x), Math.round(p.z));
}
