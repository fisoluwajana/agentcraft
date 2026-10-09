// Offline check of the chat filters (repeat, narration cooldown, ballot syntax, #town-hall routing).
// Usage: AGENTCRAFT_DATA_DIR=<empty scratch dir> node tests/manual/chat-filter-test.mjs   (Discord posting is stubbed)
import { openDb, now } from '../../agents/lib/db.js';
import { Chat } from '../../agents/src/chat.js';
import * as discord from '../../agents/lib/discord.js';
const db = openDb();
db.prepare("INSERT INTO votes(question,options,opened_by,opened_ts,closes_ts,status) VALUES(?,?,?,?,?,'open')").run('Claim the ridge water?', JSON.stringify(['Yes, build a house', 'No, shared flag']), 'Wren', now(), now() + 3600e3);
const chat = new Chat('wren', { name: 'Wren', never: [] });
chat.lastPostTs = () => 0; // ignore the 2-min pacing gap here
const lines = [
  ['general', 'going to camp by the ridge iron vein. mags is late, so i\'m not waiting anymore.'],
  ['general', 'claiming the iron vein. mags can stare at the cows until the sun sets.'],
  ['general', 'heading to the ridge iron. mags is still missing; this is mine now.'],
  ['general', 'found iron at 38,57. ridge water is yours, tobin.'],
  ['off-topic', "mags owes me an iron ingot and she's hours late."],
  ['town-hall', 'the cows are waiting for the grass to grow back.'],
  ['town-hall', 'vote: cast Yes on Claim the ridge water?'],
  ['general', 'I say yes, build a house there'],
  ['general', 'tobin, got any spare cobble?'],
];
for (const [channel, text] of lines) {
  const before = db.prepare('SELECT COUNT(*) n FROM chat').get().n;
  await chat.say([{ channel, text }], 10).catch((e) => console.log('ERR', e.message));
  const row = db.prepare('SELECT channel FROM chat ORDER BY id DESC LIMIT 1').get();
  const posted = db.prepare('SELECT COUNT(*) n FROM chat').get().n > before;
  console.log(posted ? `POST #${row.channel}` : 'held  ', '|', text);
}
process.exit(0);
