// Shared state store: one SQLite file used by every process (WAL mode).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, ts INTEGER);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL,
  channel TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
  reply_to INTEGER, thread TEXT, discord_id TEXT, kind TEXT DEFAULT 'message');
CREATE INDEX IF NOT EXISTS chat_ts ON chat(ts);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
  agent TEXT NOT NULL, call_type TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
  in_tokens INTEGER NOT NULL, out_tokens INTEGER NOT NULL, usd REAL NOT NULL, ok INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS llm_usage_day ON llm_usage(day, agent);
CREATE INDEX IF NOT EXISTS llm_usage_month ON llm_usage(month);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT, claimed_by TEXT, created_ts INTEGER, claimed_ts INTEGER, done_ts INTEGER, reward TEXT);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL,
  item TEXT NOT NULL, delta INTEGER NOT NULL, place TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS pois (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, kind TEXT, x INTEGER, y INTEGER, z INTEGER,
  found_by TEXT, ts INTEGER, note TEXT);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, agent TEXT, kind TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS events_day ON events(day);

CREATE TABLE IF NOT EXISTS agent_status (
  agent TEXT PRIMARY KEY, ts INTEGER, x REAL, y REAL, z REAL, health REAL, food REAL,
  action TEXT, action_started INTEGER, action_repeat INTEGER DEFAULT 0, deaths_today INTEGER DEFAULT 0,
  state TEXT, last_move_ts INTEGER, last_progress_ts INTEGER);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, options TEXT NOT NULL, opened_by TEXT,
  opened_ts INTEGER, closes_ts INTEGER, status TEXT DEFAULT 'open', result TEXT);
CREATE TABLE IF NOT EXISTS ballots (vote_id INTEGER, agent TEXT, option TEXT, reason TEXT, ts INTEGER,
  PRIMARY KEY (vote_id, agent));

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, target TEXT, command TEXT, args TEXT, done_ts INTEGER);
`;

let db;

export function openDb(file = path.join(config.dataDir, 'state', 'agentcraft.db')) {
  if (db) return db;
  mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  return db;
}

export const now = () => Date.now();

export function kvGet(key, fallback = null) {
  const r = openDb().prepare('SELECT value FROM kv WHERE key=?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}

export function kvSet(key, value) {
  openDb().prepare('INSERT INTO kv(key,value,ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts')
    .run(key, JSON.stringify(value), now());
}

export function logEvent(day, agent, kind, data = {}) {
  openDb().prepare('INSERT INTO events(ts,day,agent,kind,data) VALUES(?,?,?,?,?)')
    .run(now(), day, agent, kind, JSON.stringify(data));
}
