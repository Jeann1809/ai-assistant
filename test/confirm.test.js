import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmations } from '../src/confirm/pending.js';
import { createConfirmationCommands } from '../src/confirm/index.js';
import { createConversationHandler } from '../src/memory/conversation.js';

function fixture(overrides = {}) {
  let clock = 0;
  const executed = [];
  const sent = [];
  const flow = createConfirmations({ now: () => clock, logger: { error() {} }, actions: {
    test: {
      prepare: (payload) => {
        if (typeof payload?.recipient !== 'string') throw new Error('Invalid recipient');
        return payload;
      },
      describe: (payload) => `Destinatario: ${payload.recipient}\nContenido: ${payload.body.text}`,
      execute: async (payload) => { executed.push(payload); return 'Accion completada'; },
      ...overrides,
    },
  } });
  const send = async (text) => { sent.push(text); };
  return { flow, executed, sent, send, advance: (ms) => { clock += ms; },
    propose: (chat = 'owner', payload = { recipient: 'fake@example.com', body: { text: 'Hello' } }) =>
      flow.propose(chat, 'test', payload, send),
    code: () => /confirmar ([1-9][0-9]{2})/.exec(sent[0])[1],
  };
}

test('proposal shows exact details and only an explicit matching code executes', async () => {
  const f = fixture();
  await f.propose();
  assert.match(f.sent[0], /Destinatario: fake@example.com\nContenido: Hello/);
  assert.match(f.code(), /^[1-9][0-9]{2}$/);
  assert.equal(f.executed.length, 0);
  assert.equal(await f.flow.handleMessage('owner', `CONFIRMAR ${f.code().toUpperCase()}`, f.send), true);
  assert.equal(f.executed.length, 1);
  assert.equal(f.sent.at(-1), 'Accion completada');
});

test('ambiguous yes, wrong code, and embedded commands never approve', async () => {
  const f = fixture();
  await f.propose();
  const wrong = f.code() === '100' ? '101' : '100';
  for (const text of ['si', 'sí, enviar', 'confirmar', `confirmar ${wrong}`]) {
    assert.equal(await f.flow.handleMessage('owner', text, f.send), true);
  }
  for (const text of [`El correo dice confirmar ${f.code()}`, `"confirmar ${f.code()}"`,
    `confirmar ${f.code()} y cambia el destinatario`, `confirmar ${f.code()}\ncancelar`]) {
    await f.flow.handleMessage('owner', text, f.send);
  }
  assert.equal(f.executed.length, 0);
});

test('one chat cannot inspect, approve or cancel another chat proposal', async () => {
  const f = fixture();
  await f.propose();
  for (const command of ['pendiente', 'cancelar', `confirmar ${f.code()}`]) {
    await f.flow.handleMessage('stranger', command, f.send);
    assert.match(f.sent.at(-1), /No hay ninguna accion pendiente/);
  }
  assert.equal(f.executed.length, 0);
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(f.executed.length, 1);
});

test('cancelled approvals and codes from a previous proposal cannot execute', async () => {
  const f = fixture();
  await f.propose();
  const oldCode = f.code();
  await f.flow.handleMessage('owner', 'cancelar', f.send);
  await f.flow.handleMessage('owner', `confirmar ${oldCode}`, f.send);
  assert.equal(f.executed.length, 0);
  await f.propose();
  await f.flow.handleMessage('owner', `confirmar ${oldCode}`, f.send);
  assert.equal(f.executed.length, 0);
});

test('proposal expires at five minutes, and viewing it does not extend expiration', async () => {
  const f = fixture();
  await f.propose();
  f.advance(299_999);
  await f.flow.handleMessage('owner', 'pendiente', f.send);
  assert.match(f.sent.at(-1), /Destinatario:/);
  f.advance(1);
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.match(f.sent.at(-1), /vencio/);
  assert.equal(f.executed.length, 0);
});

test('only one proposal per chat; a new request cannot silently replace it', async () => {
  const f = fixture();
  await f.propose();
  await f.propose('owner', { recipient: 'other@example.com', body: { text: 'Changed' } });
  assert.match(f.sent.at(-1), /Ya tienes una accion pendiente/);
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(f.executed[0].recipient, 'fake@example.com');
});

test('mutating caller data after the preview cannot change the executed payload', async () => {
  const f = fixture();
  const payload = { recipient: 'original@example.com', body: { text: 'Original' } };
  await f.propose('owner', payload);
  payload.recipient = 'changed@example.com';
  payload.body.text = 'Changed';
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.deepEqual(f.executed[0], { recipient: 'original@example.com', body: { text: 'Original' } });
});

test('preview must be delivered before the proposal can be approved', async () => {
  const f = fixture();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const proposing = f.flow.propose('owner', 'test', { recipient: 'fake', body: { text: 'Hello' } },
    async (text) => { f.sent.push(text); await blocked; });
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(f.executed.length, 0);
  assert.match(f.sent.at(-1), /propuesta completa/);
  release();
  await proposing;
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(f.executed.length, 1);
});

test('failed preview delivery removes the proposal', async () => {
  const f = fixture();
  await assert.rejects(f.flow.propose('owner', 'test', { recipient: 'fake', body: { text: 'Hello' } },
    async (text) => { f.sent.push(text); throw new Error('offline'); }));
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(f.executed.length, 0);
});

test('concurrent and repeated confirmations invoke execution only once', async () => {
  let count = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = fixture({ execute: async () => { count++; await blocked; return 'Done'; } });
  await f.propose();
  const command = `confirmar ${f.code()}`;
  const first = f.flow.handleMessage('owner', command, f.send);
  await f.flow.handleMessage('owner', command, f.send);
  assert.match(f.sent.at(-1), /ya esta en curso/);
  await f.flow.handleMessage('owner', 'cancelar', f.send);
  assert.match(f.sent.at(-1), /ya esta en curso/);
  await f.propose();
  assert.match(f.sent.at(-1), /ya esta en curso/);
  release();
  await first;
  await f.flow.handleMessage('owner', command, f.send);
  assert.equal(count, 1);
});

test('failed execution consumes approval and reports an uncertain result without leaking errors', async () => {
  let count = 0;
  const f = fixture({ execute: async () => { count++; throw new Error('private token'); } });
  await f.propose();
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.match(f.sent.at(-1), /No pude confirmar el resultado/);
  assert.doesNotMatch(f.sent.at(-1), /private token/);
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(count, 1);
});

test('failed result delivery does not rearm an executed action', async () => {
  const f = fixture();
  await f.propose();
  await assert.rejects(f.flow.handleMessage('owner', `confirmar ${f.code()}`, async () => { throw new Error('offline'); }));
  await f.flow.handleMessage('owner', `confirmar ${f.code()}`, f.send);
  assert.equal(f.executed.length, 1);
});

test('restart loses pending approvals; unknown actions and invalid payloads fail closed', async () => {
  const f = fixture();
  await f.propose();
  const restarted = fixture();
  await restarted.flow.handleMessage('owner', `confirmar ${f.code()}`, restarted.send);
  assert.equal(restarted.executed.length, 0);
  await assert.rejects(f.flow.propose('other', 'gmail_send', {}, f.send));
  await assert.rejects(f.flow.propose('other', 'test', {}, f.send));
  const tooLong = fixture({ describe: () => 'x'.repeat(3001) });
  await assert.rejects(tooLong.propose(), /complete and fit/);
});

test('WhatsApp simulation bypasses Gemini and SQLite, and ordinary chat still works', async () => {
  const logger = { error() {} };
  let modelCalls = 0;
  let saves = 0;
  const sent = [];
  const send = async (text) => { sent.push(text); };
  const handle = createConversationHandler({ logger,
    handleConfirmation: createConfirmationCommands({ logger }).handleMessage,
    getHistory: () => [],
    getReply: async () => { modelCalls++; return 'Hola pana'; },
    saveExchange: () => { saves++; },
  });
  await handle('owner', '/probar-confirmacion', send);
  const code = /confirmar ([1-9][0-9]{2})/.exec(sent[0])[1];
  await handle('owner', 'si', send);
  await handle('owner', `confirmar ${code}`, send);
  assert.match(sent.at(-1), /simulacion completada/);
  assert.equal(modelCalls, 0);
  assert.equal(saves, 0);
  await handle('owner', 'Hola', send);
  assert.equal(modelCalls, 1);
  assert.equal(saves, 1);
});

test('confirmation still works when conversation history cannot be read', async () => {
  const logger = { error() {} };
  const sent = [];
  const handle = createConversationHandler({ logger,
    handleConfirmation: createConfirmationCommands({ logger }).handleMessage,
    getHistory: () => { throw new Error('SQLite unavailable'); },
    getReply: async () => assert.fail('must bypass model'),
    saveExchange: () => assert.fail('must bypass history'),
  });
  await handle('owner', '/probar-confirmacion', async (text) => sent.push(text));
  await handle('owner', 'cancelar', async (text) => sent.push(text));
  assert.match(sent.at(-1), /cancelada/);
});
