// Village radio. A few times each evening ops puts the village "on air" (kv `radio`); the agents then talk
// on the `radio` chat channel and this service reads their lines aloud in the 📻 village-radio voice
// channel, one Polly voice per agent, with a text transcript alongside. Spectators listen; nobody else speaks.
import { Readable } from 'node:stream';
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { config } from '../agents/lib/config.js';
import { openDb, kvGet } from '../agents/lib/db.js';
import { loadDiscordSecret } from '../agents/lib/discord.js';
import { sleep } from '../agents/lib/time.js';

const CHANNEL_NAME = 'village-radio';
const CATEGORY = '👀 Spectators';
// Standard voices only in eu-north-1; SSML prosody gives each agent a distinct delivery.
const VOICES = {
  Mags: { id: 'Amy', rate: '90%', pitch: '-10%' },   // gruff, unhurried
  Tobin: { id: 'Brian', rate: '110%', pitch: '+6%' }, // loud, fast, eager
  Wren: { id: 'Emma', rate: '95%', pitch: '+2%' },    // quiet, dry
};
const log = (...a) => console.log(new Date().toISOString(), '[radio]', ...a);
const polly = new PollyClient({ region: config.region });

const esc = (t) => t.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
// Emojis and markdown don't read aloud well.
const speakable = (t) => t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/[*_`~>#]/g, '').replace(/\s+/g, ' ').trim();

async function synth(author, text) {
  const v = VOICES[author] || { id: 'Joanna', rate: '100%', pitch: '+0%' };
  const r = await polly.send(new SynthesizeSpeechCommand({
    VoiceId: v.id, Engine: 'standard', OutputFormat: 'pcm', SampleRate: '16000', TextType: 'ssml',
    Text: `<speak><prosody rate="${v.rate}" pitch="${v.pitch}">${esc(text)}</prosody></speak>`,
  }));
  const mono16k = Buffer.from(await r.AudioStream.transformToByteArray());
  // Discord wants 48 kHz stereo s16le: upsample x3 (linear) and duplicate the channel.
  const n = mono16k.length >> 1, out = Buffer.alloc(n * 3 * 4);
  for (let i = 0; i < n; i++) {
    const a = mono16k.readInt16LE(i * 2), b = i + 1 < n ? mono16k.readInt16LE((i + 1) * 2) : a;
    for (let k = 0; k < 3; k++) {
      const s = Math.round(a + ((b - a) * k) / 3), o = (i * 3 + k) * 4;
      out.writeInt16LE(s, o); out.writeInt16LE(s, o + 2);
    }
  }
  return out;
}

async function ensureChannel(guild) {
  const chans = await guild.channels.fetch();
  let ch = chans.find((c) => c?.type === ChannelType.GuildVoice && c.name === CHANNEL_NAME);
  const overwrites = [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.Speak, PermissionFlagsBits.Stream, PermissionFlagsBits.SendMessages] }];
  if (!ch) {
    const parent = chans.find((c) => c?.type === ChannelType.GuildCategory && c.name === CATEGORY);
    ch = await guild.channels.create({ name: CHANNEL_NAME, type: ChannelType.GuildVoice, parent: parent?.id, permissionOverwrites: overwrites, reason: 'AgentCraft village radio' });
    log('created voice channel', ch.id);
  }
  return ch;
}

const secret = await loadDiscordSecret();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const ready = new Promise((r) => client.once('clientReady', r));
await client.login(secret.system_bot_token.trim());
await ready;
const guild = await client.guilds.fetch(String(secret.guild_id).trim());
const channel = await ensureChannel(guild);
log('ready; voice channel', channel.name);

const player = createAudioPlayer();
let conn = null;
let lastId = openDb().prepare("SELECT COALESCE(MAX(id),0) m FROM chat WHERE channel='radio'").get().m;

async function goLive(state) {
  conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  conn.subscribe(player);
  log('on air until', new Date(state.until).toISOString());
  await channel.send({ content: `📻 **On air now** for about ${Math.round((state.until - Date.now()) / 60000)} minutes: Mags, Tobin and Wren live from the village. Transcript below.`, allowedMentions: { parse: [] } }).catch(() => {});
}

async function goOffAir() {
  await channel.send({ content: '📻 Off air. Back later this evening.', allowedMentions: { parse: [] } }).catch(() => {});
  conn?.destroy(); conn = null;
  log('off air');
}

async function play(row) {
  const text = speakable(row.text);
  if (!text) return;
  const pcm = await synth(row.author, text);
  player.play(createAudioResource(Readable.from(pcm), { inputType: StreamType.Raw }));
  await channel.send({ content: `**${row.author}:** ${row.text}`.slice(0, 1990), allowedMentions: { parse: [] } }).catch(() => {});
  await entersState(player, AudioPlayerStatus.Playing, 5_000).catch(() => {});
  await entersState(player, AudioPlayerStatus.Idle, 60_000).catch(() => {});
  await sleep(500);
}

while (true) {
  try {
    const state = kvGet('radio');
    const live = state?.live && state.until > Date.now();
    if (live && !conn) await goLive(state);
    const rows = openDb().prepare("SELECT id, author, text FROM chat WHERE channel='radio' AND id>? ORDER BY id").all(lastId);
    for (const r of rows) { lastId = r.id; if (conn) await play(r).catch((e) => log('play failed:', e.message)); }
    if (!live && conn && !rows.length) await goOffAir();
  } catch (e) { log('loop error:', e.message); conn?.destroy(); conn = null; await sleep(10_000); }
  await sleep(1500);
}
