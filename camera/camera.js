// AgentCraft camera: takes 3D screenshots on request. Idle most of the time; for each request it logs in an
// invisible spectator ("Camera"), teleports it to frame the target, renders the view with prismarine-viewer
// in headless Chromium (software WebGL), saves the PNG and optionally posts it to Discord, then logs out.
// Requests are rows in the shared `commands` table with target='camera' (see agents/lib/camera.js).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import mineflayer from 'mineflayer';
import { Rcon } from 'rcon-client';
import { chromium } from 'playwright-core';
import { config } from '../agents/lib/config.js';
import { openDb, now } from '../agents/lib/db.js';
import { postAs } from '../agents/lib/discord.js';
import { seasonDay, sleep } from '../agents/lib/time.js';

const require = createRequire(import.meta.url);
const { mineflayer: startViewer } = require('prismarine-viewer');

const NAME = 'Camera';
const PORT = 3007;
const SHOTS = path.join(config.dataDir, 'state', 'shots');
const CHROME = process.env.CHROMIUM_PATH || undefined; // playwright's bundled build when unset
const CAMERA = { username: 'AgentCraft Camera', avatarUrl: 'https://api.dicebear.com/9.x/icons/png?seed=camera&size=128' };
const log = (...a) => console.log(new Date().toISOString(), '[camera]', ...a);

async function rcon(cmd) {
  const r = await Rcon.connect({ host: process.env.RCON_HOST || config.minecraft.host, port: config.minecraft.rconPort, password: config.minecraft.rconPassword, timeout: 5000 });
  try { return await r.send(cmd); } finally { r.end(); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: process.env.MC_HOST || config.minecraft.host, port: config.minecraft.port, username: NAME, version: config.minecraft.version, auth: 'offline' });
    const t = setTimeout(() => { bot.quit(); reject(new Error('login timed out')); }, 30_000);
    bot.once('spawn', () => { clearTimeout(t); resolve(bot); });
    bot.once('kicked', (r) => { clearTimeout(t); reject(new Error(`kicked: ${String(r).slice(0, 120)}`)); });
    bot.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** Frame a target from above and to the side; `size` is roughly how big the subject is in blocks. */
export async function shoot({ x, y, z, size = 6, width = 1280, height = 720 }) {
  const bot = await connect();
  let browser;
  try {
    await rcon(`gamemode spectator ${NAME}`);
    // Steep three-quarter view from the south-west so trees in front don't hide the subject.
    const d = Math.max(8, size * 1.4);
    const cam = [x - d * 0.7, y + Math.max(10, size * 1.6), z + d];
    await rcon(`tp ${NAME} ${cam.map((v) => v.toFixed(1)).join(' ')}`);
    await sleep(4000); // chunks around the new position
    // Mineflayer has no spectator flight: with physics on, the camera would fall and reset its view.
    bot.physicsEnabled = false;
    bot.entity.position.set(cam[0], cam[1], cam[2]);
    const dx = x + 0.5 - cam[0], dy = y + 1 - (cam[1] + 1.62), dz = z + 0.5 - cam[2];
    bot.entity.yaw = Math.atan2(-dx, -dz);
    bot.entity.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    startViewer(bot, { port: PORT, firstPerson: true, viewDistance: 3 });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage', '--renderer-process-limit=1'] });
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: 'load' });
    await page.waitForTimeout(10_000); // meshing + software rendering
    return await page.screenshot({ type: 'png' });
  } finally {
    await browser?.close().catch(() => {});
    try { bot.viewer?.close(); } catch { /* ignore */ }
    bot.quit();
  }
}

async function handle(c) {
  const a = JSON.parse(c.args || '{}');
  const t0 = Date.now();
  const png = await shoot(a);
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${c.id}.png`);
  writeFileSync(file, png);
  openDb().prepare('INSERT INTO shots(day,ts,kind,path,caption,x,y,z,by) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(a.day || seasonDay(), now(), a.kind || 'shot', file, a.caption || '', a.x, a.y, a.z, a.by || null);
  log(`shot #${c.id} (${a.kind}) in ${Date.now() - t0} ms, ${png.length} bytes`);
  if (a.channel) await postAs({ channel: a.channel, ...CAMERA, content: a.caption ? `📷 ${a.caption}` : '📷', files: [{ name: `${a.kind || 'shot'}-${c.id}.png`, data: png, type: 'image/png' }] });
}

log('camera ready');
let busy = false;
while (true) {
  if (!busy) {
    const c = openDb().prepare("SELECT * FROM commands WHERE target='camera' AND done_ts IS NULL ORDER BY id LIMIT 1").get();
    if (c) {
      busy = true;
      openDb().prepare('UPDATE commands SET done_ts=? WHERE id=?').run(now(), c.id);
      // Stale requests (host was down) are skipped rather than shot hours later.
      if (now() - c.ts > 30 * 60_000) log(`skipping stale request #${c.id}`);
      else await handle(c).catch((e) => log(`shot #${c.id} failed:`, e.message));
      busy = false;
    }
  }
  await sleep(5000);
}
