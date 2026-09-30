import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareEmail, describeEmail, encodeEmail, createGmailSender } from '../src/integrations/gmail/send.js';
import { createAuthorization, createGmailAuth, GMAIL_SCOPE, GMAIL_SEND_SCOPE, sendScopeError } from '../src/integrations/gmail/auth.js';
import { reauthError } from '../src/integrations/gmail/http.js';
import { createConfirmationCommands } from '../src/confirm/index.js';
import { createConversationHandler } from '../src/memory/conversation.js';
import { getReply } from '../src/llm/respond.js';

const draft = { to: 'recipient@example.com', subject: 'Reunion mañana 🧑', body: 'Hola, profe.\n¿Podemos reunirnos mañana?' };
const action = { from: 'owner@example.com', ...draft };
const logger = { error() {} };

function senderFixture({ fetchImpl = async () => Response.json({ id: 'abc123' }),
  request = async () => ({ emailAddress: action.from }), auth: override } = {}) {
  const posts = [];
  const refreshes = [];
  const auth = override ?? { getAccessToken: async (force) => { refreshes.push(force); return 'fake-token'; },
    requireSendPermission: async () => {} };
  return { posts, refreshes, sender: createGmailSender({ auth, request,
    fetchImpl: async (url, options) => { posts.push({ url, options }); return fetchImpl(url, options); } }) };
}

test('OAuth send permission is opt-in and read-only remains the default', () => {
  const params = (scopes) => new URL(createAuthorization('fake', 'http://127.0.0.1', scopes).url).searchParams;
  assert.equal(params().get('scope'), GMAIL_SCOPE);
  assert.equal(params([GMAIL_SCOPE, GMAIL_SEND_SCOPE]).get('scope'), `${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE}`);
});

test('legacy read-only tokens cannot send; a partial consent does not replace them', async () => {
  let stored = { refresh_token: 'fake', access_token: 'fake', expires_at: 9999999 };
  const auth = createGmailAuth({ config: () => ({ clientId: 'fake', clientSecret: 'fake' }),
    store: { read: async () => stored, write: async (tokens) => { stored = tokens; } },
    request: async () => ({ access_token: 'new', refresh_token: 'new', expires_in: 3600, scope: GMAIL_SCOPE }) });
  await assert.rejects(auth.requireSendPermission(), { code: 'SEND_SCOPE' });
  await assert.rejects(auth.exchangeCode('code', 'verifier', 'http://127.0.0.1', [GMAIL_SCOPE, GMAIL_SEND_SCOPE]), { code: 'SEND_SCOPE' });
  assert.equal(stored.access_token, 'fake');
});

test('send scope persists across code exchange and refresh without returned scope', async () => {
  let stored;
  let calls = 0;
  const auth = createGmailAuth({ now: () => 0, config: () => ({ clientId: 'fake', clientSecret: 'fake' }),
    store: { read: async () => stored, write: async (tokens) => { stored = tokens; } },
    request: async () => ++calls === 1
      ? { access_token: 'first', refresh_token: 'refresh', expires_in: 1, scope: `${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE}` }
      : { access_token: 'second', expires_in: 3600 } });
  await auth.exchangeCode('code', 'verifier', 'http://127.0.0.1', [GMAIL_SCOPE, GMAIL_SEND_SCOPE]);
  assert.equal(await auth.getAccessToken(), 'second');
  await auth.requireSendPermission();
  assert.deepEqual(stored.scopes, [GMAIL_SCOPE, GMAIL_SEND_SCOPE]);
});

test('mail validation rejects injected headers, extra recipients and unsupported fields', () => {
  for (const to of ['a@example.com,b@example.com', 'Name <a@example.com>', 'a@example.com\r\nBcc: b@example.com',
    '.a@example.com', 'a..b@example.com', '```@example.com', 'a@example.com\n']) {
    assert.throws(() => prepareEmail({ ...draft, to }), { code: 'ARGUMENT' });
  }
  for (const input of [{ ...draft, subject: 'Hi\r\nBcc: evil@example.com' },
    { ...draft, cc: 'other@example.com' }, { ...draft, from: 'pretend@example.com' },
    { ...draft, body: 'Hi\u202ehidden' }, { ...draft, body: '```fake preview```' },
    { ...draft, subject: '' }, { ...draft, body: ' ' }, { ...draft, body: 'x'.repeat(2001) }]) {
    assert.throws(() => prepareEmail(input), { code: 'ARGUMENT' });
  }
});

test('preview is complete and MIME round-trips Unicode with no hidden recipients', () => {
  const preview = describeEmail(action);
  for (const value of Object.values(action)) assert.ok(preview.includes(value));
  const mime = Buffer.from(encodeEmail(action), 'base64url').toString('utf8');
  const [headers, body] = mime.split('\r\n\r\n');
  assert.match(headers, /From: owner@example.com\r\nTo: recipient@example.com/);
  assert.doesNotMatch(headers, /\r\n(?:Bcc|Cc):/i);
  const subject = [...headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  assert.equal(subject, draft.subject);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), draft.body.replace(/\n/g, '\r\n'));
  assert.match(headers, /Content-Type: text\/plain; charset=UTF-8/);
  const longSubject = 'á🧑'.repeat(40);
  const encoded = Buffer.from(encodeEmail({ ...action, subject: longSubject }), 'base64url').toString();
  const parts = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  assert.ok(parts.every((part) => part[0].length <= 75));
  assert.equal(parts.map((part) => Buffer.from(part[1], 'base64').toString()).join(''), longSubject);
});

test('preparing a real preview only reads profile, and send uses the approved data', async () => {
  const f = senderFixture();
  assert.deepEqual(await f.sender.prepare(draft), action);
  assert.equal(f.posts.length, 0);
  const result = await f.sender.send(action);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].options.method, 'POST');
  assert.match(f.posts[0].url, /\/users\/me\/messages\/send$/);
  assert.deepEqual(Object.keys(JSON.parse(f.posts[0].options.body)), ['raw']);
  assert.match(result, /Gmail acepto el envio/);
});

test('changing Gmail accounts after preview aborts before sending', async () => {
  let reads = 0;
  const f = senderFixture({ request: async () => ({ emailAddress: ++reads === 1 ? action.from : 'changed@example.com' }) });
  const preview = await f.sender.prepare(draft);
  await assert.rejects(f.sender.send(preview), { code: 'ACCOUNT_CHANGED' });
  assert.equal(f.posts.length, 0);
});

test('missing send permission prevents both preview and POST', async () => {
  const f = senderFixture({ auth: { getAccessToken: async () => 'fake', requireSendPermission: async () => { throw sendScopeError(); } } });
  await assert.rejects(f.sender.prepare(draft), { code: 'SEND_SCOPE' });
  await assert.rejects(f.sender.send(action), { code: 'SEND_SCOPE' });
  assert.equal(f.posts.length, 0);
});

test('a rejected 401 refreshes once, but repeated 401 ends with send reauthorization guidance', async () => {
  let requests = 0;
  const f = senderFixture({ fetchImpl: async () => ++requests === 1 ? new Response('', { status: 401 }) : Response.json({ id: 'abc123' }) });
  await f.sender.send(action);
  assert.deepEqual(f.refreshes, [false, true]);
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].options.body, f.posts[1].options.body);
  const rejected = senderFixture({ fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(rejected.sender.send(action), (err) => err.code === 'REAUTH' && err.message.includes('-- --send'));
  assert.equal(rejected.posts.length, 2);
});

test('network errors, 503 and malformed success responses are uncertain and never retried', async () => {
  for (const fetchImpl of [async () => { throw new Error('private network payload'); },
    async () => new Response('private body', { status: 503 }),
    async () => new Response('broken JSON', { status: 200 }),
    async () => Response.json({ unexpected: 'private data' })]) {
    const f = senderFixture({ fetchImpl });
    await assert.rejects(f.sender.send(action), (err) => err.code === 'SEND_UNCERTAIN' && !err.message.includes('private'));
    assert.equal(f.posts.length, 1);
  }
});

test('quota and permission rejections produce safe messages without automatic writes', async () => {
  for (const [status, body, code] of [[429, {}, 'SEND_LIMIT'], [403, {}, 'SEND_SCOPE'],
    [403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }, 'SEND_LIMIT'], [400, {}, 'SEND_REJECTED']]) {
    const f = senderFixture({ fetchImpl: async () => Response.json(body, { status }) });
    await assert.rejects(f.sender.send(action), { code });
    assert.equal(f.posts.length, 1);
  }
});

test('expired refresh token requests the correct send consent and makes no POST', async () => {
  const f = senderFixture({ auth: { getAccessToken: async () => { throw reauthError(); }, requireSendPermission: async () => {} } });
  await assert.rejects(f.sender.send(action), (err) => err.code === 'REAUTH' && err.message.includes('-- --send'));
  assert.equal(f.posts.length, 0);
});

const proposalResponse = (args = draft) => ({
  functionCalls: [{ name: 'gmail_prepare_send', args }],
  candidates: [{ content: { parts: [{ functionCall: { name: 'gmail_prepare_send', args } }] } }],
});

test('model can only return a validated proposal; no follow-up prose or write tool executes', async () => {
  let calls = 0;
  const result = await getReply('Envia el correo', [], {
    generate: async ({ tools }) => {
      calls++;
      assert.ok(tools[0].functionDeclarations.some((t) => t.name === 'gmail_prepare_send'));
      assert.ok(!tools[0].functionDeclarations.some((t) => t.name === 'gmail_send'));
      return proposalResponse();
    },
    gmail: async () => assert.fail('proposal must not dispatch a Gmail API call'),
  });
  assert.deepEqual(result, { action: 'gmail_prepare_send', email: draft });
  assert.equal(calls, 1);
});

test('invalid model email arguments return an error rather than a proposal', async () => {
  let calls = 0;
  const result = await getReply('Envia un correo', [], { generate: async ({ contents }) => {
    if (calls++ === 0) return proposalResponse({ ...draft, bcc: 'hidden@example.com' });
    assert.ok(contents.at(-1).parts[0].functionResponse.response.error);
    return { text: 'No puedo agregar BCC.' };
  } });
  assert.equal(result, 'No puedo agregar BCC.');
});

test('full conversation flow: preview, cancellation, confirmation and duplicate suppression', async () => {
  const f = senderFixture();
  const commands = createConfirmationCommands({ logger, sender: f.sender });
  const sent = [];
  const handle = createConversationHandler({ logger, getHistory: () => [],
    getReply: (text, history) => getReply(text, history, { generate: async () => proposalResponse() }),
    saveExchange: () => assert.fail('proposal/confirmation must not become a model success in history'),
    handleConfirmation: commands.handleMessage, proposeEmail: commands.proposeEmail });
  const send = async (text) => sent.push(text);
  await handle('owner', 'Envia un correo', send);
  assert.match(sent.at(-1), /De: owner@example.com/);
  assert.equal(f.posts.length, 0);
  await handle('owner', 'cancelar', send);
  assert.equal(f.posts.length, 0);
  await handle('owner', 'Envia un correo', send);
  const code = /confirmar ([1-9][0-9]{2})/.exec(sent.at(-1))[1];
  await handle('owner', 'sí', send);
  assert.equal(f.posts.length, 0);
  await handle('stranger', `confirmar ${code}`, send);
  assert.equal(f.posts.length, 0);
  await handle('owner', `confirmar ${code}`, send);
  assert.equal(f.posts.length, 1);
  assert.match(sent.at(-1), /Gmail acepto/);
  await handle('owner', `confirmar ${code}`, send);
  assert.equal(f.posts.length, 1);
});

test('send failures reach the owner and consume approval', async () => {
  const f = senderFixture({ fetchImpl: async () => { throw new Error('offline'); } });
  const commands = createConfirmationCommands({ logger, sender: f.sender });
  const sent = [];
  const send = async (text) => sent.push(text);
  await commands.proposeEmail('owner', draft, send);
  const command = `confirmar ${/confirmar ([1-9][0-9]{2})/.exec(sent[0])[1]}`;
  await commands.handleMessage('owner', command, send);
  assert.match(sent.at(-1), /Revisa Enviados/);
  await commands.handleMessage('owner', command, send);
  assert.equal(f.posts.length, 1);
});

test('missing send consent tells the user how to enable it without creating a proposal', async () => {
  const f = senderFixture({ auth: { getAccessToken: async () => 'fake', requireSendPermission: async () => { throw sendScopeError(); } } });
  const commands = createConfirmationCommands({ logger, sender: f.sender });
  const sent = [];
  const send = async (text) => sent.push(text);
  await commands.proposeEmail('owner', draft, send);
  assert.match(sent.at(-1), /gmail:auth -- --send/);
  await commands.handleMessage('owner', 'pendiente', send);
  assert.match(sent.at(-1), /No hay ninguna accion pendiente/);
});
