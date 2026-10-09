// Season clock helpers. All "day" keys use the season timezone so a season that
// ends at midnight counts as one day.
import { config } from './config.js';

const tz = () => config.season.timezone;

export function localParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, hh: Number(p.hour) % 24, mm: Number(p.minute) };
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Minutes since season start, or null when outside the season window.
export function seasonMinute(d = new Date()) {
  const { hh, mm } = localParts(d);
  const now = hh * 60 + mm;
  const start = toMin(config.season.start);
  let end = toMin(config.season.end);
  if (end <= start) end += 24 * 60;
  const n = now < start && now + 24 * 60 < end ? now + 24 * 60 : now;
  return n >= start && n < end ? n - start : null;
}

export function seasonLengthMinutes() {
  const start = toMin(config.season.start);
  let end = toMin(config.season.end);
  if (end <= start) end += 24 * 60;
  return end - start;
}

// The "season day": a session that runs past midnight still belongs to the day it started.
export function seasonDay(d = new Date()) {
  const shifted = new Date(d.getTime() - 6 * 3600 * 1000);
  const { y, m, d: dd } = localParts(shifted);
  return `${y}-${m}-${dd}`;
}

export function monthKey(d = new Date()) {
  const { y, m } = localParts(d);
  return `${y}-${m}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
