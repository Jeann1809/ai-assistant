import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initShortTermMemory, closeShortTermMemory, getHistory, saveExchange } from '../src/memory/short-term.js';
import { createConversationHandler } from '../src/memory/conversation.js';

afterEach(() => closeShortTermMemory());

function handler(overrides = {}) {
  return createConversationHandler({ getHistory, saveExchange, getReply: async (text) => `reply ${text}`, logger: { error() {} }, ...overrides });
}

test('history survives reopening and stays isolated by chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-memory-'));
  try {
    const path = join(dir, 'test.sqlite');
    initShortTermMemory(path);
    saveExchange('a', 'hello', 'hi');
    saveExchange('b', 'private', 'other');
    closeShortTermMemory();
    initShortTermMemory(path);
    assert.deepEqual(getHistory('a'), [{ role: 'user', text: 'hello' }, { role: 'model', text: 'hi' }]);
    assert.deepEqual(getHistory('unknown'), []);
  } finally {
    closeShortTermMemory();
    rmSync(dir, { recursive: true });
  }
});

test('window is chronological and storage prunes complete pairs', () => {
  initShortTermMemory(':memory:');
  for (let i = 0; i < 105; i++) saveExchange('a', `user ${i}`, `model ${i}`);
  const recent = getHistory('a');
  assert.equal(recent.length, 20);
  assert.deepEqual(recent[0], { role: 'user', text: 'user 95' });
  assert.deepEqual(recent.at(-1), { role: 'model', text: 'model 104' });
  const stored = getHistory('a', 1000);
  assert.equal(stored.length, 200);
  assert.equal(stored[0].text, 'user 5');
});

test('failed second insert rolls back the entire exchange', () => {
  initShortTermMemory(':memory:');
  assert.throws(() => saveExchange('a', 'hello', null));
  assert.deepEqual(getHistory('a'), []);
});

test('overlapping follow-ups see the preceding delivered answer', async () => {
  initShortTermMemory(':memory:');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const handle = handler({ getReply: async (text, history) => {
    seen.push(history);
    if (text === 'first') await gate;
    return `reply ${text}`;
  } });
  const first = handle('a', 'first', async () => {});
  const second = handle('a', 'second', async () => {});
  await handle('b', 'independent', async () => {});
  assert.equal(seen.length, 2);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen[2], [{ role: 'user', text: 'first' }, { role: 'model', text: 'reply first' }]);
});

test('failed send is not saved and the next turn still works', async () => {
  initShortTermMemory(':memory:');
  const handle = handler();
  await handle('a', 'lost', async () => { throw new Error('offline'); });
  assert.deepEqual(getHistory('a'), []);
  await handle('a', 'next', async () => {});
  assert.equal(getHistory('a')[0].text, 'next');
});

test('generation and read failures send a fallback without saving it', async () => {
  initShortTermMemory(':memory:');
  for (const overrides of [
    { getReply: async () => { throw new Error('unavailable'); } },
    { getHistory: () => { throw new Error('unreadable'); } },
  ]) {
    const sent = [];
    await handler(overrides)('a', 'hello', async (text) => sent.push(text));
    assert.equal(sent.length, 1);
    assert.deepEqual(getHistory('a'), []);
  }
});

test('save failure preserves delivery and warns about missing context', async () => {
  initShortTermMemory(':memory:');
  const sent = [];
  await handler({ saveExchange: () => { throw new Error('disk full'); } })('a', 'hello', async (text) => sent.push(text));
  assert.equal(sent[0], 'reply hello');
  assert.match(sent[1], /No pude guardar/);
  assert.deepEqual(getHistory('a'), []);
});
