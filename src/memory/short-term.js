import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger.js';

// How many recent messages get replayed to Gemini on each turn. Kept even so
// the window always starts on a user message (we only ever store user+model
// pairs). More history = better follow-ups but more input tokens per request,
// and Gemini free tier token limits may change — recheck ai.google.dev.
const HISTORY_LIMIT = 20;

// Rows kept per chat on disk. Older ones are pruned on every save so the DB
// can't grow without bound on a 6GB VM.
const MAX_STORED_PER_CHAT = 200;

let db;
let insertStmt;
let selectStmt;
let pruneStmt;

// Called once at startup, after dotenv has loaded — reading the env var at
// import time would run before config() (ES imports are hoisted). A failure
// here (bad path, corrupt file, unwritable dir) is fatal on purpose: better to
// crash on boot than to run an assistant that silently has no memory.
export function initShortTermMemory(path = process.env.SHORT_TERM_DB_PATH || './data/short-term.sqlite') {
  if (db) throw new Error('short-term memory already initialized');
  mkdirSync(dirname(path), { recursive: true });

  db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT    NOT NULL,
      role       TEXT    NOT NULL CHECK (role IN ('user', 'model')),
      content    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);
  `);

  insertStmt = db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)');
  selectStmt = db.prepare(
    'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
  );
  // delete everything older than the Nth-newest row for this chat
  pruneStmt = db.prepare(`
    DELETE FROM messages
    WHERE chat_id = ?
      AND id <= (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)
  `);

  logger.info({ path }, 'short-term memory ready');
}

export function closeShortTermMemory() {
  db?.close();
  db = undefined;
}

function requireDb() {
  if (!db) throw new Error('short-term memory used before initShortTermMemory()');
}

// Most recent messages for a chat, oldest first, as { role, text }.
export function getHistory(chatId, limit = HISTORY_LIMIT) {
  requireDb();
  return selectStmt
    .all(chatId, limit)
    .reverse()
    .map((row) => ({ role: row.role, text: row.content }));
}

// Stores one user message and the reply to it as a single transaction, so a
// crash can never leave an orphaned user turn without its answer. Only the
// final text is stored — not tool calls or raw search results; the model's
// answer already summarizes those, and replaying them would burn tokens.
export function saveExchange(chatId, userText, replyText) {
  requireDb();
  db.transaction(() => {
    insertStmt.run(chatId, 'user', userText);
    insertStmt.run(chatId, 'model', replyText);
    pruneStmt.run(chatId, chatId, MAX_STORED_PER_CHAT);
  })();
}
