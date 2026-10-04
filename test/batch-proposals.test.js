import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEventBatch, createEventBatch } from '../src/integrations/calendar/batch.js';
import { CalendarError } from '../src/integrations/calendar/http.js';
import { prepareMemoryProposals } from '../src/memory/proposal.js';
import { openLongTermMemory } from '../src/memory/long-term.js';
import { createFactMemory } from '../src/memory/facts.js';
import { createConfirmations } from '../src/confirm/pending.js';
import { createConfirmationCommands } from '../src/confirm/index.js';
import { createConversationHandler } from '../src/memory/conversation.js';
import { getReply } from '../src/llm/respond.js';

const logger = { error() {}, warn() {} };
const events = ['Estudiar', 'Entrenar', 'Leer'].map((summary, index) => ({ summary,
  start: `2026-10-0${index + 6}T15:00:00-05:00`, end: `2026-10-0${index + 6}T16:00:00-05:00`, allDay: false }));
const memories = [{ key: 'universidad', value: 'Estudio en Texas Tech' }, { key: 'bebida', value: 'Prefiero cafe sin azucar' }];
const userText = memories.map((memory) => memory.value).join('. ');
const payload = { events: events.map((event) => ({ calendarId: 'owner@example.com', ...event })) };
const code = (sent) => /confirmar \d{3}/.exec(sent.at(-1))[0];
const call = (name, args) => ({ functionCalls: [{ name, args }], candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });

test('batch validation bounds size, rejects duplicates and validates every item', () => {
  assert.deepEqual(prepareEventBatch({ events }), events);
  for (const bad of [[], Array(6).fill(events[0]), [events[0], events[0]], [events[0], { ...events[1], end: 'bad' }]]) {
    assert.throws(() => prepareEventBatch({ events: bad }), { code: 'ARGUMENT' });
  }
  assert.deepEqual(prepareMemoryProposals({ memories }, userText), memories);
  for (const bad of [[], Array(6).fill(memories[0]), [memories[0], { ...memories[1], key: 'UNIVERSIDAD' }],
    [memories[0], { ...memories[1], value: 'Invented fact' }]]) {
    assert.throws(() => prepareMemoryProposals({ memories: bad }, userText));
  }
});
test('one event approval creates the full snapshot exactly once; cancellation creates nothing', async () => {
  const created = [], sent = [];
  const calendar = { prepare: async (event) => ({ calendarId: 'owner@example.com', ...event }),
    create: async (event) => { created.push(event); return 'ok'; } };
  const commands = createConfirmationCommands({ logger, calendar });
  const send = async (text) => sent.push(text);
  const inputs = structuredClone(events);
  await commands.proposeEvents('owner', inputs, send);
  assert.equal(sent.length, 4);
  for (let index = 0; index < 3; index++) assert.ok(sent[index].includes(events[index].summary));
  const cancelled = code(sent);
  await commands.handleMessage('owner', 'cancelar', send);
  await commands.handleMessage('owner', cancelled, send);
  assert.equal(created.length, 0);
  await commands.proposeEvents('owner', inputs, send);
  const approve = code(sent);
  inputs[0].summary = 'Changed after preview';
  await commands.handleMessage('other', approve, send);
  await commands.handleMessage('owner', 'si', send);
  assert.equal(created.length, 0);
  await commands.handleMessage('owner', approve, send);
  assert.deepEqual(created, payload.events);
  assert.match(sent.at(-1), /Lote completado/);
  await commands.handleMessage('owner', approve, send);
  assert.equal(created.length, 3);
});
test('failed or changed-account preparation never creates a pending batch or an event', async () => {
  for (const fail of [true, false]) {
    let prepared = 0; const sent = [];
    const calendar = { prepare: async (event) => {
      prepared++;
      if (fail && prepared === 2) throw new CalendarError('REAUTH', 'Autoriza Calendar');
      return { calendarId: prepared === 2 ? 'changed@example.com' : 'owner@example.com', ...event };
    }, create: () => assert.fail('no writes during preparation') };
    const commands = createConfirmationCommands({ logger, calendar });
    const send = async (text) => sent.push(text);
    await commands.proposeEvents('owner', events, send);
    assert.ok(!sent.some((text) => /confirmar \d{3}/.test(text)));
    await commands.handleMessage('owner', 'pendiente', send);
    assert.match(sent.at(-1), /No hay ninguna/);
  }
});
test('partial Calendar failure reports created, uncertain and unattempted events without retries', async () => {
  let attempts = 0;
  const result = await createEventBatch({ create: async () => {
    if (++attempts === 2) throw new CalendarError('CREATE_UNCERTAIN', 'Revisa Google Calendar antes de repetir.');
  } }, payload);
  assert.equal(attempts, 2);
  assert.match(result, /Creado: 1\. Estudiar/);
  assert.match(result, /Resultado incierto: 2\. Entrenar/);
  assert.match(result, /Sin intentar: 3\. Leer/);
});
test('known rejection differs from an uncertain write and consumes the batch approval', async () => {
  let attempts = 0; const sent = [];
  const commands = createConfirmationCommands({ logger, calendar: {
    prepare: async (event) => ({ calendarId: 'owner@example.com', ...event }),
    create: async () => { attempts++; throw new CalendarError('CREATE_LIMIT', 'Cuota agotada'); },
  } });
  const send = async (text) => sent.push(text);
  await commands.proposeEvents('owner', events, send);
  const approve = code(sent);
  await commands.handleMessage('owner', approve, send);
  assert.match(sent.at(-1), /No creado: 1/);
  assert.match(sent.at(-1), /Sin intentar: 2/);
  await commands.handleMessage('owner', approve, send);
  assert.equal(attempts, 1);
});
test('batch preview delivery must finish before approval and delivery failure discards it', async () => {
  let executions = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const commands = createConfirmations({ logger, actions: { batch: {
    prepare: (value) => value, describe: () => ['First complete item', 'Second complete item'],
    execute: async () => { executions++; return 'ok'; },
  } } });
  const sent = []; let deliveries = 0;
  const proposal = commands.propose('owner', 'batch', {}, async (text) => {
    sent.push(text);
    if (++deliveries === 2) await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  await commands.handleMessage('owner', 'confirmar 123', async (text) => sent.push(text));
  assert.match(sent.at(-1), /Espera a recibir/);
  assert.equal(executions, 0);
  release(); await proposal;
  const approve = code(sent);
  await commands.handleMessage('owner', approve, async () => {});
  assert.equal(executions, 1);
  let count = 0;
  await assert.rejects(commands.propose('owner', 'batch', {}, async () => {
    if (++count === 2) throw new Error('WhatsApp unavailable');
  }));
  await commands.handleMessage('owner', 'pendiente', async (text) => sent.push(text));
  assert.match(sent.at(-1), /No hay ninguna/);
});
test('viewing a batch resends all items and does not extend its expiry', async () => {
  let now = 0;
  const commands = createConfirmations({ logger, now: () => now, actions: { batch: {
    prepare: (value) => value, describe: () => ['Item one', 'Item two'], execute: () => assert.fail('expired'),
  } } });
  const sent = [], send = async (text) => sent.push(text);
  await commands.propose('owner', 'batch', {}, send);
  const approve = code(sent);
  now = 299999;
  await commands.handleMessage('owner', 'pendiente', send);
  assert.equal(sent.length, 6);
  now = 300000;
  await commands.handleMessage('owner', approve, send);
  assert.match(sent.at(-1), /vencio/);
});
test('memory batch previews replacements and commits every item with one confirmation', async () => {
  const store = openLongTermMemory(':memory:');
  try {
    let embeddings = 0;
    const factMemory = createFactMemory({ store, logger, embed: async () => { embeddings++; throw new Error('offline'); } });
    const commands = createConfirmationCommands({ logger, factMemory });
    const sent = [], send = async (text) => sent.push(text);
    store.save('owner', memories[0].key, 'Estudio en otra universidad');
    await commands.proposeMemories('owner', memories, send);
    assert.match(sent[0], /Reemplaza: Estudio en otra universidad/);
    assert.equal(embeddings, 0);
    const approve = code(sent);
    await commands.handleMessage('owner', approve, send);
    assert.deepEqual(store.list('owner').map(({ key, value }) => ({ key, value })), [...memories].reverse());
    assert.deepEqual(store.list('other'), []);
    assert.match(sent.at(-1), /Recuerdos guardados \(2\)/);
    await commands.handleMessage('owner', approve, send);
    assert.equal(embeddings, 2);
  } finally { store.close(); }
});
test('a stale memory value or capacity failure prevents the whole batch', async () => {
  const store = openLongTermMemory(':memory:');
  try {
    const factMemory = createFactMemory({ store, logger, embed: async () => null });
    const stale = factMemory.prepareProposals('owner', memories);
    store.save('owner', memories[1].key, 'Cambio manual');
    const result = await factMemory.saveProposals(stale);
    assert.match(result, /No guarde ninguno/);
    assert.equal(store.list('owner').length, 1);
    assert.equal(store.list('owner')[0].value, 'Cambio manual');
    for (let index = 0; index < 98; index++) store.save('full', `fact${index}`, 'Dato existente');
    const prepared = factMemory.prepareProposals('full', memories);
    store.save('full', 'last', 'Cambio despues de la propuesta');
    assert.match(await factMemory.saveProposals(prepared), /No se guardo ninguno/);
    assert.equal(store.list('full').length, 99);
    assert.ok(!store.list('full').some((row) => memories.some((memory) => memory.key === row.key)));
  } finally { store.close(); }
});
test('invalid vectors and stale snapshots reject the whole memory batch', () => {
  const store = openLongTermMemory(':memory:');
  try {
    assert.throws(() => store.saveBatch('owner', [
      { ...memories[0], previous: null, vector: null },
      { ...memories[1], value: 'x'.repeat(200), previous: null, vector: null },
    ].map((row, index) => index === 1 ? { ...row, previous: 'stale' } : row)));
    assert.deepEqual(store.list('owner'), []);
    assert.throws(() => store.saveBatch('owner', [{ ...memories[0], previous: null }, { ...memories[1], previous: null, vector: [NaN] }]));
    assert.deepEqual(store.list('owner'), []);
  } finally { store.close(); }
});
test('a database failure on the second insert rolls back the first insert', () => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-batch-test-'));
  const path = join(directory, 'fixture.sqlite');
  let store, connection;
  try {
    store = openLongTermMemory(path);
    connection = new Database(path);
    connection.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON facts
      WHEN NEW.key = 'bebida' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
    assert.throws(() => store.saveBatch('owner', memories.map((memory) => ({ ...memory, previous: null }))));
    assert.deepEqual(store.list('owner'), []);
  } finally {
    connection?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('already-saved facts are skipped; a fully redundant batch produces no approval', async () => {
  const store = openLongTermMemory(':memory:');
  try {
    const factMemory = createFactMemory({ store, logger });
    const commands = createConfirmationCommands({ logger, factMemory });
    for (const memory of memories) store.save('owner', memory.key, memory.value);
    const sent = [], send = async (text) => sent.push(text);
    await commands.proposeMemories('owner', memories, send);
    assert.match(sent.at(-1), /ya estan guardados/);
    assert.ok(!sent.some((text) => /confirmar \d{3}/.test(text)));
    const partial = factMemory.prepareProposals('owner', [...memories, { key: 'nuevo', value: 'Dato nuevo' }]);
    assert.equal(partial.memories.length, 1);
  } finally { store.close(); }
});
test('event and memory batches share the existing one-action slot', async () => {
  const store = openLongTermMemory(':memory:');
  try {
    const commands = createConfirmationCommands({ logger, factMemory: createFactMemory({ store, logger }),
      calendar: { prepare: async (event) => ({ calendarId: 'owner@example.com', ...event }), create: () => assert.fail('not approved') } });
    const sent = [], send = async (text) => sent.push(text);
    await commands.proposeEvents('owner', events, send);
    await commands.proposeMemories('owner', memories, send);
    assert.match(sent.at(-1), /Ya tienes una accion pendiente/);
    assert.deepEqual(store.list('owner'), []);
  } finally { store.close(); }
});
test('Gemini proposes validated batches without executing tools or generating follow-up prose', async () => {
  for (const [name, args, text, expected] of [
    ['calendar_prepare_create_many', { events }, 'Crea estos eventos', { action: 'calendar_prepare_create_many', events }],
    ['memory_propose_many', { memories }, userText, { action: 'memory_propose_many', memories }],
  ]) {
    let calls = 0;
    const result = await getReply(text, [], { generate: async ({ tools }) => {
      calls++;
      assert.ok(tools[0].functionDeclarations.some((tool) => tool.name === name));
      return call(name, args);
    }, calendar: () => assert.fail('no read/write'), gmail: () => assert.fail('no read/write') });
    assert.deepEqual(result, expected);
    assert.equal(calls, 1);
  }
});
test('memory batches after retrieval and mixed proposal batches are rejected', async () => {
  let turns = 0;
  const result = await getReply(userText, [], { calendar: async () => ({ events: [] }), generate: async ({ contents }) => {
    if (++turns === 1) return call('calendar_list_events', {});
    if (turns === 2) return call('memory_propose_many', { memories });
    assert.ok(contents.at(-1).parts[0].functionResponse.response.error);
    return { text: 'No guarde recuerdos.' };
  } });
  assert.equal(result, 'No guarde recuerdos.');
  turns = 0;
  await getReply(userText, [], { generate: async ({ contents }) => {
    if (++turns === 1) {
      const calls = [{ name: 'memory_propose_many', args: { memories } }, { name: 'calendar_prepare_create_many', args: { events } }];
      return { functionCalls: calls, candidates: [{ content: { parts: calls.map((functionCall) => ({ functionCall })) } }] };
    }
    assert.ok(contents.at(-1).parts.every((part) => part.functionResponse.response.error));
    return { text: 'Un lote por turno.' };
  } });
});
test('conversation routes both batch types without storing an unexecuted success', async () => {
  const proposed = [];
  const handle = createConversationHandler({ logger, getHistory: () => [],
    getReply: async (text) => text === 'events' ? { action: 'calendar_prepare_create_many', events } : { action: 'memory_propose_many', memories },
    proposeEvents: async (chatId, inputs) => proposed.push({ chatId, inputs }),
    proposeMemories: async (chatId, inputs) => proposed.push({ chatId, inputs }),
    saveExchange: () => assert.fail('not saved as success'),
  });
  await handle('owner', 'events', async () => {});
  await handle('owner', 'memories', async () => {});
  assert.deepEqual(proposed, [{ chatId: 'owner', inputs: events }, { chatId: 'owner', inputs: memories }]);
});
