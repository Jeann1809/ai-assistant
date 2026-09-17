import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

const DB_PATH = process.env.SHORT_TERM_DB_PATH || './data/short-term.sqlite';

// how many past messages (user + model combined) to feed back to gemini per
// reply — keeps prompts small enough for the free tier's TPM limits
const HISTORY_LIMIT = 20;

let db;

function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'model')),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_jid_created ON messages (jid, created_at);
  `);

  return db;
}

// Returns the last `limit` messages for a chat, oldest first — ready to feed
// straight into a Gemini `contents` array. Falls back to no history rather
// than crashing the reply flow if the DB is unreadable.
export function getRecentHistory(jid, limit = HISTORY_LIMIT) {
  try {
    const rows = getDb()
      .prepare('SELECT role, text FROM messages WHERE jid = ? ORDER BY id DESC LIMIT ?')
      .all(jid, limit);

    return rows.reverse();
  } catch (err) {
    logger.error({ err, jid }, 'failed to read short-term history — continuing without it');
    return [];
  }
}

// Best-effort persistence — a failed write shouldn't break the reply that
// already went out over WhatsApp, so this only logs on failure.
export function addMessage(jid, role, text) {
  try {
    getDb()
      .prepare('INSERT INTO messages (jid, role, text, created_at) VALUES (?, ?, ?, ?)')
      .run(jid, role, text, Date.now());
  } catch (err) {
    logger.error({ err, jid, role }, 'failed to persist message to short-term history');
  }
}
