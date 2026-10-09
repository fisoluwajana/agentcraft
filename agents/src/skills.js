// Deterministic skill library. Every skill is plain code: no LLM calls happen here.
// Each returns { ok, summary, gained? } so the brain can tell what changed.
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { openDb, now } from '../lib/db.js';

const { goals, Movements } = pf;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SkillError extends Error {}

function invCounts(bot) {
  const c = {};
  for (const it of bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count;
  return c;
}
function diff(before, after) {
  const g = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d) g[k] = d;
  }
  return g;
}
const count = (bot, name) => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);

function poi(name) {
  return openDb().prepare('SELECT * FROM pois WHERE lower(name)=lower(?)').get(name);
}

async function withTimeout(promise, ms, what) {
  let t;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new SkillError(`${what} timed out`)), ms); })]);
  } finally { clearTimeout(t); }
}

export async function gotoPos(bot, x, y, z, range = 2, timeoutMs = 90_000) {
  const goal = y == null ? new goals.GoalNearXZ(x, z, range) : new goals.GoalNear(x, y, z, range);
  try {
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, 'walking');
  } catch (e) {
    bot.pathfinder.stop();
    throw new SkillError(`couldn't reach ${Math.round(x)},${y == null ? '~' : Math.round(y)},${Math.round(z)}: ${e.message}`);
  }
}

// Wood can be any log type; accept "log"/"wood" as wildcards.
function blockIds(bot, name) {
  const reg = bot.registry;
  const n = name.toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (['log', 'logs', 'wood'].includes(n)) return Object.values(reg.blocksByName).filter((b) => b.name.endsWith('_log')).map((b) => b.id);
  if (['stone', 'cobblestone'].includes(n)) return ['stone', 'cobblestone'].map((k) => reg.blocksByName[k].id);
  const b = reg.blocksByName[n];
  if (!b) throw new SkillError(`unknown block '${name}'`);
  const ids = [b.id];
  if (n.endsWith('_ore') && reg.blocksByName[`deepslate_${n}`]) ids.push(reg.blocksByName[`deepslate_${n}`].id);
  return ids;
}

async function ensureTable(bot) {
  const reg = bot.registry;
  let table = bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 24 });
  if (table) return table;
  if (count(bot, 'crafting_table') === 0) await craft(bot, { item: 'crafting_table', count: 1 });
  await placeNear(bot, 'crafting_table');
  table = bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 6 });
  if (!table) throw new SkillError('placed a crafting table but lost track of it');
  return table;
}

// Place an item on any free spot next to the bot.
async function placeNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new SkillError(`no ${itemName} to place`);
  await bot.equip(item, 'hand');
  const p = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) {
    const below = bot.blockAt(p.offset(dx, -1, dz));
    const spot = bot.blockAt(p.offset(dx, 0, dz));
    if (below && below.boundingBox === 'block' && spot && spot.name === 'air') {
      try { await bot.placeBlock(below, new Vec3(0, 1, 0)); return p.offset(dx, 0, dz); } catch { /* try next */ }
    }
  }
  throw new SkillError(`no room to place ${itemName}`);
}

// Place a block at an exact position, using any solid neighbour as the reference.
export async function placeAt(bot, pos, itemName) {
  const existing = bot.blockAt(pos);
  if (existing && existing.boundingBox === 'block') return false;
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new SkillError(`ran out of ${itemName}`);
  if (bot.entity.position.distanceTo(pos) > 4.2) await gotoPos(bot, pos.x, pos.y, pos.z, 3);
  // don't place into our own body
  const feet = bot.entity.position.floored();
  if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
    await gotoPos(bot, pos.x + 2, pos.y, pos.z + 2, 1).catch(() => {});
  }
  await bot.equip(item, 'hand');
  const faces = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  for (const [dx, dy, dz] of faces) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (ref && ref.boundingBox === 'block') {
      try { await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)); return true; } catch { /* next face */ }
    }
  }
  throw new SkillError(`nothing to attach a block to at ${pos}`);
}

// ---------------------------------------------------------------- skills

export const SKILLS = {
  goto: {
    describe: 'goto {x,z,y?} or {poi:"name"} or {player:"Name"}: walk somewhere',
    async run(bot, a) {
      let x = a.x, y = a.y, z = a.z;
      if (a.poi) { const p = poi(a.poi); if (!p) throw new SkillError(`no place called '${a.poi}' on the map`); ({ x, y, z } = p); }
      if (a.player) { const e = bot.players[a.player]?.entity; if (!e) throw new SkillError(`can't see ${a.player}`); ({ x, y, z } = e.position); }
      if (x == null || z == null) throw new SkillError('goto needs x and z, a poi or a player');
      await gotoPos(bot, x, y, z, 2);
      return { ok: true, summary: `walked to ${Math.round(x)},${Math.round(z)}` };
    },
  },

  explore: {
    describe: 'explore {direction:"north|south|east|west"?, distance?:40-200}: walk out and look around, marking anything interesting',
    async run(bot, a, ctx) {
      const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
      const d = dirs[a.direction] || Object.values(dirs)[Math.floor(Math.random() * 4)];
      const dist = Math.min(Math.max(Number(a.distance) || 80, 30), 200);
      const p = bot.entity.position;
      await gotoPos(bot, p.x + d[0] * dist, null, p.z + d[1] * dist, 4, 150_000).catch(() => {});
      const found = scanSurroundings(bot);
      for (const f of found) ctx.discover(f);
      return { ok: true, summary: `explored ${Math.round(bot.entity.position.distanceTo(p))} blocks; saw ${found.map((f) => f.kind).join(', ') || 'nothing special'}` };
    },
  },

  collect: {
    describe: 'collect {block:"oak_log|log|stone|coal_ore|iron_ore|sand|dirt|...", count}: find and mine blocks nearby',
    async run(bot, a) {
      const want = Math.min(Math.max(Number(a.count) || 8, 1), 64);
      const ids = blockIds(bot, a.block);
      const before = invCounts(bot);
      let got = 0, misses = 0;
      while (got < want && misses < 4) {
        const positions = bot.findBlocks({ matching: ids, maxDistance: 48, count: Math.min(want - got, 8) });
        if (!positions.length) break;
        const targets = positions.map((p) => bot.blockAt(p)).filter(Boolean);
        try {
          await withTimeout(bot.collectBlock.collect(targets, { ignoreNoPath: true }), 120_000, 'mining');
        } catch { misses++; }
        const g = diff(before, invCounts(bot));
        const n = Object.values(g).filter((v) => v > 0).reduce((s, v) => s + v, 0);
        if (n === got) misses++;
        got = n;
      }
      const gained = diff(before, invCounts(bot));
      if (!Object.keys(gained).length) throw new SkillError(`couldn't find or mine any ${a.block} nearby`);
      return { ok: true, summary: `mined ${Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ')}`, gained };
    },
  },

  craft: {
    describe: 'craft {item:"oak_planks|stick|crafting_table|wooden_pickaxe|stone_pickaxe|furnace|chest|bread|...", count}: crafts, placing a crafting table if needed',
    async run(bot, a) { return craft(bot, a); },
  },

  smelt: {
    describe: 'smelt {item:"raw_iron|raw_gold|sand|...", count}: smelt using a nearby or newly placed furnace and coal/charcoal/planks as fuel',
    async run(bot, a) {
      const reg = bot.registry;
      const n = Math.min(Number(a.count) || 4, 16);
      let furnaceBlock = bot.findBlock({ matching: reg.blocksByName.furnace.id, maxDistance: 24 });
      if (!furnaceBlock) {
        if (!count(bot, 'furnace')) await craft(bot, { item: 'furnace', count: 1 });
        await placeNear(bot, 'furnace');
        furnaceBlock = bot.findBlock({ matching: reg.blocksByName.furnace.id, maxDistance: 6 });
      }
      await gotoPos(bot, furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2);
      const input = bot.inventory.items().find((i) => i.name === a.item);
      if (!input) throw new SkillError(`no ${a.item} to smelt`);
      const fuel = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks'].map((f) => bot.inventory.items().find((i) => i.name === f)).find(Boolean);
      if (!fuel) throw new SkillError('no fuel (coal or planks)');
      const before = invCounts(bot);
      const furnace = await bot.openFurnace(furnaceBlock);
      try {
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(n / (fuel.name.includes('coal') ? 8 : 1.5))));
        await furnace.putInput(input.type, null, Math.min(n, input.count));
        const deadline = Date.now() + n * 10_500 + 5000;
        while (Date.now() < deadline) { await sleep(3000); if (furnace.outputItem()) await furnace.takeOutput().catch(() => {}); if (!furnace.inputItem()) break; }
        if (furnace.outputItem()) await furnace.takeOutput();
      } finally { furnace.close(); }
      const gained = diff(before, invCounts(bot));
      return { ok: true, summary: `smelted: ${Object.entries(gained).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing yet'}`, gained };
    },
  },

  build_shelter: {
    describe: 'build_shelter {material:"oak_planks|cobblestone|...", size?:5, x?,z?}: a small closed hut with a roof and a door gap',
    async run(bot, a) {
      const mat = a.material || 'oak_planks';
      const size = Math.min(Math.max(Number(a.size) || 5, 4), 7);
      const need = (size * 4 - 4) * 3 + size * size - 2;
      if (count(bot, mat) < need) throw new SkillError(`need about ${need} ${mat}, have ${count(bot, mat)}`);
      const origin = (a.x != null ? new Vec3(Math.floor(a.x), Math.floor(bot.entity.position.y), Math.floor(a.z)) : bot.entity.position.floored()).offset(2, 0, 2);
      const ground = bot.blockAt(origin.offset(0, -1, 0));
      if (!ground || ground.boundingBox !== 'block') throw new SkillError('ground here is not solid');
      let placed = 0;
      for (let y = 0; y < 3; y++) {
        for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) {
          const edge = i === 0 || j === 0 || i === size - 1 || j === size - 1;
          const door = i === Math.floor(size / 2) && j === 0 && y < 2;
          if (edge && !door) placed += (await placeAt(bot, origin.offset(i, y, j), mat).catch(() => false)) ? 1 : 0;
        }
      }
      for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) placed += (await placeAt(bot, origin.offset(i, 3, j), mat).catch(() => false)) ? 1 : 0;
      return { ok: placed > need * 0.7, summary: `built a ${size}x${size} ${mat} shelter at ${origin.x},${origin.y},${origin.z} (${placed} blocks)`, built: { x: origin.x, y: origin.y, z: origin.z, size, mat } };
    },
  },

  build_line: {
    describe: 'build_line {material, x1,y1,z1, x2,y2,z2}: wall, path or pillar between two points (max 64 blocks)',
    async run(bot, a) {
      const p1 = new Vec3(a.x1, a.y1, a.z1).floored(), p2 = new Vec3(a.x2, a.y2, a.z2).floored();
      const pts = [];
      for (let x = Math.min(p1.x, p2.x); x <= Math.max(p1.x, p2.x); x++)
        for (let y = Math.min(p1.y, p2.y); y <= Math.max(p1.y, p2.y); y++)
          for (let z = Math.min(p1.z, p2.z); z <= Math.max(p1.z, p2.z); z++) pts.push(new Vec3(x, y, z));
      if (pts.length > 64) throw new SkillError('too big for one build_line (max 64 blocks)');
      pts.sort((u, v) => u.y - v.y);
      let placed = 0;
      for (const p of pts) placed += (await placeAt(bot, p, a.material).catch(() => false)) ? 1 : 0;
      return { ok: placed > 0, summary: `placed ${placed}/${pts.length} ${a.material}` };
    },
  },

  farm: {
    describe: 'farm {x?,z?}: harvest ripe wheat, till dirt next to water and plant seeds',
    async run(bot, a) {
      const reg = bot.registry;
      const before = invCounts(bot);
      if (a.x != null) await gotoPos(bot, a.x, null, a.z, 3);
      // harvest
      const ripe = bot.findBlocks({ matching: reg.blocksByName.wheat.id, maxDistance: 16, count: 32 })
        .map((p) => bot.blockAt(p)).filter((b) => b && b.getProperties().age === 7);
      for (const b of ripe) { await gotoPos(bot, b.position.x, b.position.y, b.position.z, 2).catch(() => {}); await bot.dig(b).catch(() => {}); }
      await sleep(800);
      // till + plant
      const hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'));
      const water = bot.findBlock({ matching: reg.blocksByName.water.id, maxDistance: 16 });
      let planted = 0;
      if (hoe && water && count(bot, 'wheat_seeds') > 0) {
        const soil = bot.findBlocks({ matching: [reg.blocksByName.dirt.id, reg.blocksByName.grass_block.id, reg.blocksByName.farmland.id], maxDistance: 5, count: 24, point: water.position })
          .filter((p) => bot.blockAt(p.offset(0, 1, 0))?.name === 'air');
        for (const p of soil.slice(0, 12)) {
          let b = bot.blockAt(p);
          try {
            await gotoPos(bot, p.x, p.y, p.z, 2);
            if (b.name !== 'farmland') { await bot.equip(hoe, 'hand'); await bot.activateBlock(b); await sleep(250); b = bot.blockAt(p); }
            if (b.name === 'farmland' && count(bot, 'wheat_seeds')) {
              await bot.equip(bot.inventory.items().find((i) => i.name === 'wheat_seeds'), 'hand');
              await bot.placeBlock(b, new Vec3(0, 1, 0)); planted++;
            }
          } catch { /* skip tile */ }
        }
      }
      const gained = diff(before, invCounts(bot));
      if (!ripe.length && !planted) throw new SkillError(hoe ? (water ? 'no seeds or no soil near water' : 'no water nearby for a farm') : 'need a hoe to farm');
      return { ok: true, summary: `harvested ${ripe.length} wheat, planted ${planted}`, gained };
    },
  },

  store: {
    describe: 'store {items:["cobblestone",...]|"all_but_tools", poi?:"community chest"}: put items in a chest (logged in the ledger)',
    async run(bot, a, ctx) {
      const chestBlock = await findChest(bot, a.poi);
      const c = await bot.openContainer(chestBlock);
      const moved = {};
      try {
        const keep = (i) => /(_pickaxe|_axe|_sword|_shovel|_hoe)$/.test(i.name) || i.name.endsWith('_bed');
        const items = bot.inventory.items().filter((i) => (a.items === 'all_but_tools' || !a.items ? !keep(i) : a.items.includes(i.name)));
        for (const it of items) { try { await c.deposit(it.type, null, it.count); moved[it.name] = (moved[it.name] || 0) + it.count; } catch { /* chest full */ } }
      } finally { c.close(); }
      for (const [item, n] of Object.entries(moved)) ctx.ledger(item, n, a.poi || 'chest', 'stored');
      return { ok: true, summary: `stored ${Object.entries(moved).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}` };
    },
  },

  take: {
    describe: 'take {item, count, poi?}: take items from a chest (logged in the ledger)',
    async run(bot, a, ctx) {
      const chestBlock = await findChest(bot, a.poi);
      const c = await bot.openContainer(chestBlock);
      let got = 0;
      try {
        const it = c.containerItems().find((i) => i.name === a.item);
        if (!it) throw new SkillError(`no ${a.item} in that chest`);
        got = Math.min(Number(a.count) || it.count, it.count);
        await c.withdraw(it.type, null, got);
      } finally { c.close(); }
      ctx.ledger(a.item, -got, a.poi || 'chest', 'taken');
      return { ok: true, summary: `took ${got} ${a.item}` };
    },
  },

  give: {
    describe: 'give {player:"Name", item, count}: walk to someone and hand them items',
    async run(bot, a, ctx) {
      const e = bot.players[a.player]?.entity;
      if (!e) throw new SkillError(`can't see ${a.player}`);
      await gotoPos(bot, e.position.x, e.position.y, e.position.z, 2);
      const it = bot.inventory.items().find((i) => i.name === a.item);
      if (!it) throw new SkillError(`no ${a.item} to give`);
      const n = Math.min(Number(a.count) || 1, count(bot, a.item));
      await bot.lookAt(e.position.offset(0, 1.6, 0));
      await bot.toss(it.type, null, n);
      ctx.ledger(a.item, -n, `gift:${a.player}`, `gave to ${a.player}`);
      return { ok: true, summary: `gave ${a.player} ${n} ${a.item}` };
    },
  },

  eat: {
    describe: 'eat {}: eat the best food in inventory',
    async run(bot) {
      const foods = bot.registry.foodsByName;
      const best = bot.inventory.items().filter((i) => foods[i.name]).sort((x, y) => foods[y.name].foodPoints - foods[x.name].foodPoints)[0];
      if (!best) throw new SkillError('no food');
      await bot.equip(best, 'hand');
      await bot.consume();
      return { ok: true, summary: `ate ${best.name}` };
    },
  },

  sleep: {
    describe: 'sleep {}: sleep in a nearby bed (night only)',
    async run(bot) {
      const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 });
      if (!bed) throw new SkillError('no bed nearby');
      await gotoPos(bot, bed.position.x, bed.position.y, bed.position.z, 2);
      await bot.sleep(bed);
      return { ok: true, summary: 'went to sleep' };
    },
  },

  fight: {
    describe: 'fight {mob?:"zombie|skeleton|spider|..."}: attack the nearest hostile mob',
    async run(bot, a) {
      const target = bot.nearestEntity((e) => e.type === 'hostile' && (!a.mob || e.name === a.mob) && e.position.distanceTo(bot.entity.position) < 16);
      if (!target) throw new SkillError('no hostile mob nearby');
      const weapon = bot.inventory.items().find((i) => i.name.endsWith('_sword')) || bot.inventory.items().find((i) => i.name.endsWith('_axe'));
      if (weapon) await bot.equip(weapon, 'hand');
      const deadline = Date.now() + 20_000;
      while (target.isValid && Date.now() < deadline) {
        if (bot.entity.position.distanceTo(target.position) > 3) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        else { bot.pathfinder.setGoal(null); await bot.lookAt(target.position.offset(0, target.height * 0.8, 0)); bot.attack(target); }
        await sleep(600);
      }
      bot.pathfinder.setGoal(null);
      return { ok: !target.isValid, summary: target.isValid ? `fought a ${target.name} but it got away` : `killed a ${target.name}` };
    },
  },

  flee: {
    describe: 'flee {}: run away from danger towards base',
    async run(bot) {
      const base = poi('base');
      if (base) await gotoPos(bot, base.x, base.y, base.z, 4).catch(() => {});
      else { const p = bot.entity.position; await gotoPos(bot, p.x + 24, null, p.z + 24, 4).catch(() => {}); }
      return { ok: true, summary: 'ran for it' };
    },
  },

  follow: {
    describe: 'follow {player, seconds?:30}: tag along with someone',
    async run(bot, a) {
      const e = bot.players[a.player]?.entity;
      if (!e) throw new SkillError(`can't see ${a.player}`);
      bot.pathfinder.setGoal(new goals.GoalFollow(e, 3), true);
      await sleep(Math.min(Number(a.seconds) || 30, 120) * 1000);
      bot.pathfinder.setGoal(null);
      return { ok: true, summary: `followed ${a.player} for a bit` };
    },
  },

  mark: {
    describe: 'mark {name, kind?:"base|farm|mine|chest|build|landmark|danger", note?}: add the current spot to the shared map',
    async run(bot, a, ctx) {
      const p = bot.entity.position.floored();
      ctx.poi({ name: a.name, kind: a.kind || 'landmark', x: p.x, y: p.y, z: p.z, note: a.note });
      return { ok: true, summary: `marked '${a.name}' at ${p.x},${p.y},${p.z}` };
    },
  },

  wait: {
    describe: 'wait {seconds?:30}: stand around (chatting, thinking, waiting for someone)',
    async run(bot, a) { await sleep(Math.min(Number(a.seconds) || 30, 120) * 1000); return { ok: true, summary: 'waited' }; },
  },
};

async function craft(bot, a) {
  const reg = bot.registry;
  const name = String(a.item).replace(/^minecraft:/, '');
  const item = reg.itemsByName[name];
  if (!item) throw new SkillError(`unknown item '${a.item}'`);
  const n = Math.min(Math.max(Number(a.count) || 1, 1), 64);
  const before = invCounts(bot);
  // Auto-make planks/sticks from logs when a recipe is missing them.
  const tryRecipes = async (table) => bot.recipesFor(item.id, null, 1, table);
  let recipes = await tryRecipes(null);
  let table = null;
  if (!recipes.length) {
    const needsTable = bot.recipesAll(item.id, null, true).length > 0;
    if (needsTable) { table = await ensureTable(bot); await gotoPos(bot, table.position.x, table.position.y, table.position.z, 2); recipes = await tryRecipes(table); }
  }
  if (!recipes.length && name !== 'oak_planks' && !name.endsWith('_planks')) {
    // try making planks/sticks first
    const log = bot.inventory.items().find((i) => i.name.endsWith('_log'));
    if (log) {
      const plank = reg.itemsByName[log.name.replace('_log', '_planks')];
      const pr = bot.recipesFor(plank.id, null, 1, null)[0];
      if (pr) await bot.craft(pr, Math.min(log.count, 4), null);
      if (name !== 'stick') { const sr = bot.recipesFor(reg.itemsByName.stick.id, null, 1, null)[0]; if (sr && count(bot, 'stick') < 4) await bot.craft(sr, 1, null); }
      recipes = await tryRecipes(table);
    }
  }
  if (!recipes.length) throw new SkillError(`missing materials for ${name}`);
  const perCraft = recipes[0].result.count;
  await bot.craft(recipes[0], Math.ceil(n / perCraft), table);
  const gained = diff(before, invCounts(bot));
  return { ok: true, summary: `crafted ${gained[name] || n} ${name}`, gained };
}

async function findChest(bot, poiName) {
  const reg = bot.registry;
  const p = poiName ? poi(poiName) : poi('community chest');
  if (p) await gotoPos(bot, p.x, p.y, p.z, 3);
  const chest = bot.findBlock({ matching: [reg.blocksByName.chest.id, reg.blocksByName.barrel.id], maxDistance: p ? 6 : 24 });
  if (!chest) throw new SkillError(p ? `no chest at '${p.name}'` : 'no chest nearby');
  await gotoPos(bot, chest.position.x, chest.position.y, chest.position.z, 2);
  return chest;
}

// Things worth telling the others about.
export function scanSurroundings(bot) {
  const reg = bot.registry;
  const found = [];
  const look = [
    ['diamond_ore', 'diamonds'], ['deepslate_diamond_ore', 'diamonds'], ['iron_ore', 'iron'], ['deepslate_iron_ore', 'iron'],
    ['coal_ore', 'coal'], ['gold_ore', 'gold'], ['water', 'water'], ['lava', 'lava'], ['sugar_cane', 'sugar cane'],
    ['bell', 'a village'], ['spawner', 'a monster spawner'], ['chest', 'a chest'],
  ];
  for (const [name, kind] of look) {
    const b = reg.blocksByName[name];
    if (!b) continue;
    const hit = bot.findBlock({ matching: b.id, maxDistance: 32 });
    if (hit) found.push({ kind, x: hit.position.x, y: hit.position.y, z: hit.position.z });
  }
  for (const e of Object.values(bot.entities)) {
    if (['cow', 'sheep', 'pig', 'chicken'].includes(e.name) && e.position.distanceTo(bot.entity.position) < 24) {
      found.push({ kind: `${e.name}s`, x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) });
      break;
    }
  }
  return found;
}

export function skillIndex() {
  return Object.entries(SKILLS).map(([k, v]) => `- ${v.describe}`).join('\n');
}

export function setupMovements(bot) {
  const m = new Movements(bot);
  m.allowSprinting = true;
  m.canDig = true;
  m.allow1by1towers = true;
  bot.pathfinder.setMovements(m);
}

export { invCounts, count };
export const _now = now;
