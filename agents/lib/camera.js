// Ask the camera service (camera/camera.js) for a screenshot. Fire-and-forget: it picks the request up
// within seconds, saves the PNG to the shots table and posts it to `channel` if one is given.
import { openDb, now } from './db.js';
import { seasonDay } from './time.js';

export function requestShot({ x, y, z, size = 6, kind = 'build', caption = '', channel = null, by = null }) {
  const args = { x: Math.round(x), y: Math.round(y), z: Math.round(z), size, kind, caption, channel, by, day: seasonDay() };
  openDb().prepare('INSERT INTO commands(ts,target,command,args) VALUES(?,?,?,?)').run(now(), 'camera', 'shot', JSON.stringify(args));
}
