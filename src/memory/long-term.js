import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DIMENSIONS, EMBEDDING_VERSION, normalizeVector } from './embeddings.js';

export const MAX_FACTS = 100;
export function memoryKey(value) {
  const key = value.trim().toLowerCase();
  if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(key)) throw new Error('Usa una clave de 1 a 40 letras, numeros, guiones o guiones bajos.');
  return key;
}
export function memoryValue(value) {
  const text = value.trim();
  if (!text || text.length > 300 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) {
    throw new Error('El recuerdo debe tener entre 1 y 300 caracteres, en una sola linea.');
  }
  return text;
}
const vectorBlob = (values) => Buffer.from(new Float32Array(normalizeVector(values)).buffer);
const words = (text) => new Set(text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .match(/[\p{L}\p{N}]{3,}/gu)?.filter((word) => !['que', 'para', 'con', 'una', 'los', 'las', 'del', 'por', 'como', 'cual', 'mis', 'the', 'and', 'what'].includes(word)) ?? []);

export function openLongTermMemory(path = process.env.LONG_TERM_DB_PATH || './data/long-term.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    sqliteVec.load(db);
    db.pragma('secure_delete = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS facts (
      chat_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      embedding BLOB, embedding_version TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(chat_id, key),
      CHECK(embedding IS NULL OR length(embedding) = ${DIMENSIONS * 4})
    )`);
  } catch (err) { db.close(); throw err; }
  const all = db.prepare('SELECT key, value, updated_at FROM facts WHERE chat_id = ? ORDER BY key');
  const count = db.prepare('SELECT count(*) AS n FROM facts WHERE chat_id = ?');
  const get = db.prepare('SELECT key FROM facts WHERE chat_id = ? AND key = ?');
  const upsert = db.prepare(`INSERT INTO facts(chat_id, key, value, embedding, embedding_version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, key) DO UPDATE SET value=excluded.value, embedding=excluded.embedding,
      embedding_version=excluded.embedding_version, updated_at=datetime('now')`);
  const remove = db.prepare('DELETE FROM facts WHERE chat_id = ? AND key = ?');
  const nearest = db.prepare(`SELECT key, value, updated_at, vec_distance_cosine(embedding, ?) AS distance
    FROM facts WHERE chat_id = ? AND embedding_version = ? AND embedding IS NOT NULL
    ORDER BY distance, key LIMIT 3`);
  return {
    close: () => db.close(),
    list: (chatId) => all.all(chatId),
    save: db.transaction((chatId, key, value, vector = null) => {
      key = memoryKey(key);
      value = memoryValue(value);
      if (!get.get(chatId, key) && count.get(chatId).n >= MAX_FACTS) throw new Error('Llegaste a 100 recuerdos. Borra uno con /olvidar antes de guardar otro.');
      upsert.run(chatId, key, value, vector ? vectorBlob(vector) : null, vector ? EMBEDDING_VERSION : null);
    }),
    forget: (chatId, key) => remove.run(chatId, memoryKey(key)).changes > 0,
    search(chatId, query, vector = null) {
      const tokens = words(query);
      const lexical = all.all(chatId).map((row) => ({ ...row,
        overlap: [...words(`${row.key} ${row.value}`)].filter((word) => tokens.has(word)).length,
      })).filter((row) => row.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.key.localeCompare(b.key));
      // Scalar sqlite-vec distance keeps ordinary SQL updates/deletes atomic.
      // At <=100 rows per chat an ANN/vec0 index adds complexity without benefit.
      const semantic = vector ? nearest.all(vectorBlob(vector), chatId, EMBEDDING_VERSION)
        .filter((row) => row.distance <= 0.6) : [];
      const unique = new Map();
      for (const row of [...lexical, ...semantic]) if (!unique.has(row.key)) unique.set(row.key, row);
      return [...unique.values()].slice(0, 3).map(({ key, value, updated_at }) => ({ key, value, updated_at }));
    },
  };
}
