// Tiny CLI used by host scripts: node ops/notify.js "message" -> #ops
import { ops } from '../agents/lib/discord.js';
await ops(process.argv.slice(2).join(' '));
