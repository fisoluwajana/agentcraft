// Top-down map of the village for the Chronicle: surface colours recorded by the agents (map_chunks),
// relief shading, each agent's track for the day, and numbered markers for points of interest.
import { openDb } from '../agents/lib/db.js';
import { config } from '../agents/lib/config.js';
import { Canvas } from '../agents/lib/png.js';

export const AGENT_COLORS = { mags: [225, 60, 60], tobin: [250, 165, 40], wren: [60, 200, 230] };
const EMOJI = { mags: '🔴', tobin: '🟠', wren: '🔵' };
const UNKNOWN = [28, 30, 36];

function chunkLookup(db, x0, z0, x1, z1) {
  const rows = db.prepare('SELECT cx,cz,rgb,height FROM map_chunks WHERE cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?')
    .all(Math.floor(x0 / 16), Math.floor(x1 / 16), Math.floor(z0 / 16), Math.floor(z1 / 16));
  const m = new Map(rows.map((r) => [`${r.cx},${r.cz}`, r]));
  return (x, z) => {
    const r = m.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    if (!r) return null;
    const i = (((z % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16);
    const rgb = Buffer.from(r.rgb), h = Buffer.from(r.height);
    return { c: [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], h: h.readInt16LE(i * 2) };
  };
}

/** Returns { png, legend, size } or null when there is no map data for the day. */
export function renderDayMap(day, { maxPx = 840 } = {}) {
  const db = openDb();
  const tracks = db.prepare('SELECT agent,x,z FROM map_tracks WHERE day=? ORDER BY ts').all(day);
  const pois = db.prepare('SELECT name,kind,x,y,z,found_by FROM pois ORDER BY ts DESC LIMIT 40').all();
  const anchor = tracks.length ? tracks : pois;
  if (!anchor.length || !db.prepare('SELECT COUNT(*) n FROM map_chunks').get().n) return null;

  // Frame: everywhere the agents went today (and the POIs near it), padded, capped at 448 blocks.
  const xs = anchor.map((p) => p.x), zs = anchor.map((p) => p.z);
  let x0 = Math.min(...xs) - 40, x1 = Math.max(...xs) + 40, z0 = Math.min(...zs) - 40, z1 = Math.max(...zs) + 40;
  const span = Math.min(Math.max(x1 - x0, z1 - z0, 160), 448);
  const cx = Math.round((x0 + x1) / 2), cz = Math.round((z0 + z1) / 2);
  x0 = cx - span / 2; z0 = cz - span / 2; x1 = x0 + span; z1 = z0 + span;
  const s = Math.max(1, Math.floor(maxPx / span));
  const W = span * s;
  const at = chunkLookup(db, x0, z0, x1, z1);
  const cv = new Canvas(W, W, UNKNOWN);

  // Terrain with vanilla-map style relief: lighter where higher than the block to the north.
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    const here = at(x, z);
    if (!here) continue;
    const north = at(x, z - 1);
    const d = north ? here.h - north.h : 0;
    const f = d > 0 ? 1.12 : d < 0 ? 0.82 : 1;
    const c = here.c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
    cv.rect((x - x0) * s, (z - z0) * s, s, s, c);
  }
  const P = (x, z) => [(x - x0 + 0.5) * s, (z - z0 + 0.5) * s];

  // Tracks, then where each agent ended the day.
  const byAgent = {};
  for (const t of tracks) (byAgent[t.agent] ||= []).push(t);
  for (const [agent, pts] of Object.entries(byAgent)) {
    const col = AGENT_COLORS[agent] || [255, 255, 255];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = P(pts[i - 1].x, pts[i - 1].z), [bx, by] = P(pts[i].x, pts[i].z);
      if (Math.hypot(bx - ax, by - ay) > 120 * s) continue; // teleport/respawn jump
      for (const [ox, oy] of [[-1, -1], [2, -1], [-1, 2], [2, 2]]) cv.line(ax + ox, ay + oy, bx + ox, by + oy, [0, 0, 0], 0.35); // dark edge
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cv.line(ax + ox, ay + oy, bx + ox, by + oy, col, 0.9);
    }
    const last = pts.at(-1);
    const [lx, ly] = P(last.x, last.z);
    cv.dot(lx, ly, Math.max(3, s + 1), col);
  }

  // Numbered POI markers (inside the frame only).
  const shown = pois.filter((p) => p.x >= x0 && p.x < x1 && p.z >= z0 && p.z < z1).slice(0, 15);
  shown.forEach((p, i) => {
    const [px, py] = P(p.x, p.z);
    cv.dot(px, py, 2, [255, 255, 255], [0, 0, 0]);
    cv.label(px + 4, py - 6, i + 1, 2);
  });

  // Scale bar: 50 blocks, bottom left.
  cv.rect(10, W - 16, 50 * s, 4, [255, 255, 255]);
  cv.label(10, W - 32, 50, 2);

  const names = config.agents.map((a) => `${EMOJI[a.id] || '⚪'} ${a.id[0].toUpperCase()}${a.id.slice(1)}`).join(' · ');
  const legend = [
    `🗺️ **Map of the day** (north is up, ${span}×${span} blocks around ${cx},${cz}; bar = 50 blocks). Trails: ${names}.`,
    ...shown.map((p, i) => `**${i + 1}** ${p.name}${p.kind ? ` (${p.kind})` : ''} ${p.x},${p.y},${p.z}${p.found_by ? `, found by ${p.found_by}` : ''}`),
  ].join('\n');
  return { png: cv.png(), legend, size: W };
}
