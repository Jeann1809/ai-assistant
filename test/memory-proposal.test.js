import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLongTermMemory } from '../src/memory/long-term.js';
import { createFactMemory } from '../src/memory/facts.js';
import { prepareMemoryProposal } from '../src/memory/proposal.js';
import { createConfirmationCommands } from '../src/confirm/index.js';
import { getReply } from '../src/llm/respond.js';
import { createConversationHandler } from '../src/memory/conversation.js';

const logger = { warn() {}, error() {} };
const fact = { key: 'materia', value: 'Este semestre estudio bases de datos' };
const call = (name, args) => ({ functionCalls: [{ name, args }], candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });

test('memory proposals require an exact current-message quote', () => {
  assert.deepEqual(prepareMemoryProposal(fact, fact.value), fact);
  assert.throws(() => prepareMemoryProposal(fact, 'Hola'));
  assert.throws(() => prepareMemoryProposal({ key: 'bad key', value: 'Hola' }, 'Hola'));
});

test('model proposes data without executing memory writes', async () => {
  const reply = await getReply(fact.value, [], { generate: async () => call('memory_propose', fact) });
  assert.deepEqual(reply, { action: 'memory_propose', memory: fact });
});

test('memory proposals after retrieved data are rejected even with a matching quote', async () => {
  let turn = 0;
  const reply = await getReply(fact.value, [], {
    generate: async ({ contents }) => {
      if (turn++ === 0) return call('gmail_search', { query: 'test' });
      if (turn === 2) return call('memory_propose', fact);
      assert.ok(contents.at(-1).parts[0].functionResponse.response.error);
      return { text: 'Respuesta normal' };
    }, gmail: async () => ({ text: fact.value }),
  });
  assert.equal(reply, 'Respuesta normal');
});

test('hybrid flow shows replacement, requires confirmation, and saves exactly once', async () => {
  const store = openLongTermMemory(':memory:');
  let embeds = 0;
  const memory = createFactMemory({ store, logger, embed: async () => { embeds++; throw new Error('offline'); } });
  const commands = createConfirmationCommands({ logger, factMemory: memory });
  const sent = [];
  const send = async (text) => sent.push(text);
  try {
    store.save('owner', 'materia', 'Estudio algoritmos');
    await commands.proposeMemory('owner', fact, send);
    assert.match(sent[0], /Reemplaza: Estudio algoritmos/);
    assert.ok(sent[0].includes(fact.value));
    const command = /confirmar [1-9][0-9]{2}/.exec(sent[0])[0];
    assert.equal(embeds, 0);
    await commands.handleMessage('other', command, send);
    await commands.handleMessage('owner', 'si', send);
    assert.equal(store.list('owner')[0].value, 'Estudio algoritmos');
    await commands.handleMessage('owner', command, send);
    assert.equal(store.list('owner')[0].value, fact.value);
    assert.equal(embeds, 1);
    await commands.handleMessage('owner', command, send);
    assert.equal(embeds, 1);
  } finally { store.close(); }
});

test('cancelled and stale proposals cannot overwrite memory', async () => {
  const store = openLongTermMemory(':memory:');
  const memory = createFactMemory({ store, logger, embed: async () => { throw new Error('offline'); } });
  const commands = createConfirmationCommands({ logger, factMemory: memory });
  const sent = [];
  const send = async (text) => sent.push(text);
  try {
    await commands.proposeMemory('owner', fact, send);
    const old = /confirmar [1-9][0-9]{2}/.exec(sent.at(-1))[0];
    await commands.handleMessage('owner', 'cancelar', send);
    await commands.handleMessage('owner', old, send);
    assert.deepEqual(store.list('owner'), []);
    await commands.proposeMemory('owner', fact, send);
    const command = /confirmar [1-9][0-9]{2}/.exec(sent.at(-1))[0];
    store.save('owner', 'materia', 'Cambio manual');
    await commands.handleMessage('owner', command, send);
    assert.match(sent.at(-1), /cambio desde la propuesta/);
    assert.equal(store.list('owner')[0].value, 'Cambio manual');
  } finally { store.close(); }
});

test('memory and email share one pending slot; duplicate facts produce no proposal', async () => {
  const store = openLongTermMemory(':memory:');
  const memory = createFactMemory({ store, logger });
  const commands = createConfirmationCommands({ logger, factMemory: memory });
  const sent = [];
  const send = async (text) => sent.push(text);
  try {
    await commands.handleMessage('owner', '/probar-confirmacion', send);
    await commands.proposeMemory('owner', fact, send);
    assert.match(sent.at(-1), /Ya tienes una accion pendiente/);
    await commands.handleMessage('owner', 'cancelar', send);
    store.save('owner', fact.key, fact.value);
    await commands.proposeMemory('owner', fact, send);
    assert.match(sent.at(-1), /ya esta guardado/);
    await commands.handleMessage('owner', 'pendiente', send);
    assert.match(sent.at(-1), /No hay ninguna/);
  } finally { store.close(); }
});

test('conversation routes a memory proposal without storing a fake successful answer', async () => {
  let proposed;
  const handle = createConversationHandler({ logger, getHistory: () => [],
    getReply: async () => ({ action: 'memory_propose', memory: fact }),
    proposeMemory: async (chat, input) => { proposed = { chat, input }; },
    saveExchange: () => assert.fail('proposal is not a saved answer'),
  });
  await handle('owner', fact.value, async () => {});
  assert.deepEqual(proposed, { chat: 'owner', input: fact });
});
