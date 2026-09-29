import { createGmailAuth } from './auth.js';
import { GmailError, requestJson } from './http.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BODY_LIMIT = 4000;
const malformed = () => new GmailError('MALFORMED', 'Gmail devolvio datos incompletos. Intenta de nuevo.');

function boundedInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new GmailError('ARGUMENT', `Usa un numero entero entre 1 y ${max}.`);
  }
  return value;
}

function htmlToText(html) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(?:br\b[^>]*|\/p|\/div|\/li|\/tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity])
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, value) => {
      const number = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : ' ';
    }).replace(/[ \t]+/g, ' ').trim();
}

export function parseMessage(message) {
  if (typeof message?.id !== 'string' || !message.payload || !Array.isArray(message.payload.headers)) {
    throw malformed();
  }
  const header = (name) => String(message.payload.headers.find((h) =>
    typeof h.name === 'string' && h.name.toLowerCase() === name)?.value ?? '').slice(0, 1000);
  const plain = [];
  const html = [];
  let omittedParts = false;
  function visit(part, depth = 0) {
    if (depth > 20 || !part || typeof part !== 'object') { omittedParts = true; return; }
    if (part.filename || part.body?.attachmentId) { omittedParts = true; return; }
    if (typeof part.body?.data === 'string' && ['text/plain', 'text/html'].includes(part.mimeType)) {
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(part.body.data)) throw malformed();
      const contentType = part.headers?.find((h) => h.name?.toLowerCase() === 'content-type')?.value ?? '';
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
      let text;
      try { text = new TextDecoder(charset).decode(Buffer.from(part.body.data, 'base64url')); }
      catch { omittedParts = true; return; }
      (part.mimeType === 'text/plain' ? plain : html).push(text);
    }
    if (Array.isArray(part.parts)) part.parts.forEach((child) => visit(child, depth + 1));
  }
  visit(message.payload);
  const text = plain.length ? plain.join('\n') : htmlToText(html.join('\n'));
  const snippet = typeof message.snippet === 'string' ? message.snippet.slice(0, 500) : '';
  return { id: message.id, from: header('from'), subject: header('subject'), date: header('date'),
    text: (text || snippet).slice(0, BODY_LIMIT),
    truncated: text.length > BODY_LIMIT, omittedParts, snippetOnly: !text,
    // Gmail IDs are not URLs supplied by message content.
    link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.id)}` };
}

export function createGmailClient({ auth = createGmailAuth(), request = requestJson } = {}) {
  async function get(path, params = {}) {
    const url = new URL(`${API}/${path}`);
    url.search = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.getAccessToken(attempt === 1);
      try { return await request(url, { headers: { Authorization: `Bearer ${token}` } }); }
      catch (err) {
        if (err.code !== 'REAUTH' || attempt === 1) throw err;
      }
    }
  }

  async function list(params) {
    const data = await get('messages', params);
    if ((data.messages !== undefined && !Array.isArray(data.messages)) ||
      (data.messages === undefined && data.resultSizeEstimate !== 0) ||
      (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) throw malformed();
    const messages = data.messages ?? [];
    if (messages.some((m) => typeof m?.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(m.id))) throw malformed();
    return { messages, nextPageToken: data.nextPageToken ?? null };
  }

  async function readMessage(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
      throw new GmailError('ARGUMENT', 'Usa el ID de un correo devuelto por gmail_search.');
    }
    return parseMessage(await get(`messages/${encodeURIComponent(id)}`, { format: 'full' }));
  }

  return {
    readMessage,
    async search({ query, maxResults, pageToken } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 1000 ||
        (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 2000))) {
        throw new GmailError('ARGUMENT', 'Indica una consulta de Gmail valida.');
      }
      const count = boundedInteger(maxResults, 5, 10);
      const page = await list({ q: query, maxResults: String(count), ...(pageToken ? { pageToken } : {}) });
      const messages = [];
      for (const item of page.messages.slice(0, count)) {
        const data = await get(`messages/${item.id}`, { format: 'metadata' });
        if (!Array.isArray(data.payload?.headers)) throw malformed();
        const header = (name) => String(data.payload.headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '').slice(0, 1000);
        messages.push({ id: item.id, from: header('from'), subject: header('subject'), date: header('date'),
          snippet: typeof data.snippet === 'string' ? data.snippet.slice(0, 500) : '' });
      }
      return { messages, nextPageToken: page.nextPageToken };
    },
    async canvasDigest({ lookbackDays } = {}) {
      const days = boundedInteger(lookbackDays, 60, 365);
      const labels = await get('labels');
      if (!Array.isArray(labels.labels)) throw malformed();
      const canvas = labels.labels.find((label) => label.name === 'Canvas');
      if (!canvas || typeof canvas.id !== 'string') {
        throw new GmailError('LABEL_MISSING', 'No encuentro la etiqueta Canvas en esta cuenta de Gmail. Revisa la cuenta autorizada y el filtro.');
      }
      // A label ID is enforced separately from q, so model text cannot broaden it.
      const page = await list({ labelIds: canvas.id, q: `newer_than:${days}d`, maxResults: '20' });
      const messages = [];
      let unavailable = 0;
      for (const item of page.messages.slice(0, 20)) {
        try { messages.push(await readMessage(item.id)); }
        catch (err) {
          if (err.code !== 'NOT_FOUND') throw err;
          unavailable++;
        }
      }
      return { messages, receivedWithinDays: days, moreAvailable: Boolean(page.nextPageToken), unavailable,
        limitation: 'Email evidence only, not the Canvas assignment calendar. Received dates are NOT due dates. ' +
          'Extract explicit due dates from the content, distinguish announcements/grades/comments, and cite message IDs or links. ' +
          'Do not infer no pending assignments from no matching emails. Older notices, omitted parts and later changes may be missing.' };
    },
  };
}
