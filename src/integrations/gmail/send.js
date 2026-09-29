import { randomUUID } from 'node:crypto';
import { createGmailAuth, sendScopeError } from './auth.js';
import { GmailError, requestJson } from './http.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const invalid = (message) => new GmailError('ARGUMENT', message);
const uncertain = () => new GmailError('SEND_UNCERTAIN',
  'No pude confirmar si Gmail envio el correo. No repetire el envio. Revisa Enviados antes de pedir otra propuesta.');
const reauthorizeSend = () => new GmailError('REAUTH',
  'Toca autorizar Gmail de nuevo con lectura y envio: npm.cmd run gmail:auth -- --send. Luego pide una nueva propuesta.');

function address(value) {
  // One ordinary ASCII addr-spec only: no display names, lists or hidden headers.
  if (typeof value !== 'string' || value.length > 254 || value.includes('```') ||
    !/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(value) ||
    value.split('@')[0].length > 64) {
    throw invalid('Indica una sola direccion de correo valida, sin nombre ni CC/BCC.');
  }
  return value;
}

export function prepareEmail(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['to', 'subject', 'body'].includes(key))) {
    throw invalid('Solo se admiten destinatario, asunto y cuerpo de texto, sin adjuntos ni campos adicionales.');
  }
  const to = address(input.to);
  const { subject, body } = input;
  // Reject bidirectional/invisible controls and code fences so the plain-text
  // preview cannot conceal or reinterpret the exact approved content.
  const hidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]|```/u;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 160 || /[\r\n\t]/.test(subject) || hidden.test(subject)) {
    throw invalid('Usa un asunto de 1 a 160 caracteres, sin saltos de linea ni controles de formato.');
  }
  if (typeof body !== 'string' || !body.trim() || body.length > 2000 || hidden.test(body)) {
    throw invalid('Usa un cuerpo de texto de 1 a 2000 caracteres, sin bloques de codigo ni caracteres invisibles.');
  }
  return { to, subject, body: body.replace(/\r\n?/g, '\n') };
}

export function validateEmailAction(input) {
  if (!input || Object.keys(input).some((key) => !['from', 'to', 'subject', 'body'].includes(key))) {
    throw invalid('Propuesta de correo invalida.');
  }
  return { from: address(input.from), ...prepareEmail({ to: input.to, subject: input.subject, body: input.body }) };
}

export function describeEmail(input) {
  const email = validateEmailAction(input);
  return '*Correo pendiente de envio*\n```\n' +
    `De: ${email.from}\nPara: ${email.to}\nAsunto: ${email.subject}\n\n${email.body}\n` + '```';
}

export function encodeEmail(input) {
  const email = validateEmailAction(input);
  // RFC 2047 encoded words, folded without splitting UTF-8 code points.
  const chunks = [];
  let chunk = '';
  for (const char of email.subject) {
    if (Buffer.byteLength(chunk + char) > 42) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  const subject = chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
  const body = Buffer.from(email.body.replace(/\n/g, '\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
  const mime = [
    `From: ${email.from}`, `To: ${email.to}`, `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@whatsapp-assistant.invalid>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}

export function createGmailSender({ auth = createGmailAuth(), request = requestJson, fetchImpl = fetch } = {}) {
  async function context(forceRefresh = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let token;
      try { token = await auth.getAccessToken(forceRefresh || attempt === 1); }
      catch (err) { if (err.code === 'REAUTH') throw reauthorizeSend(); throw err; }
      await auth.requireSendPermission();
      try {
        const profile = await request(`${API}/profile`, { headers: { Authorization: `Bearer ${token}` } });
        return { token, from: address(profile.emailAddress) };
      } catch (err) {
        if (err.code === 'REAUTH' && attempt === 0) continue;
        if (err.code === 'REAUTH') throw reauthorizeSend();
        throw err;
      }
    }
  }

  return {
    async prepare(input) {
      const email = prepareEmail(input);
      const { from } = await context();
      return { from, ...email };
    },
    async send(input) {
      const email = validateEmailAction(input);
      const raw = encodeEmail(email);
      for (let attempt = 0; attempt < 2; attempt++) {
        const { token, from } = await context(attempt === 1);
        if (from !== email.from) throw new GmailError('ACCOUNT_CHANGED',
          'La cuenta de Gmail cambio desde la propuesta. No envie el correo. Pide una nueva propuesta.');
        let response;
        try {
          response = await fetchImpl(`${API}/messages/send`, { method: 'POST', redirect: 'error',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw }), signal: AbortSignal.timeout(15_000) });
        } catch { throw uncertain(); }
        // A 401 is a rejected authorization, not an ambiguous delivery. Refresh
        // once and verify the account again. Never retry network/429/5xx failures.
        if (response.status === 401) {
          if (attempt === 0) continue;
          throw reauthorizeSend();
        }
        if (response.status === 403) {
          let data;
          try { data = await response.json(); } catch { /* known rejection, never log the body */ }
          if (data?.error?.errors?.some((item) => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(item.reason))) {
            throw new GmailError('SEND_LIMIT', 'Gmail rechazo el envio por cuota. Espera antes de pedir otra propuesta; no se reintentara automaticamente.');
          }
          throw sendScopeError();
        }
        if (response.status === 429) throw new GmailError('SEND_LIMIT',
          'Gmail limito el envio. No lo repetire automaticamente. Espera y revisa Enviados antes de pedir otra propuesta.');
        if (response.status >= 500 || (response.status >= 300 && response.status < 400)) throw uncertain();
        if (!response.ok) throw new GmailError('SEND_REJECTED',
          'Gmail rechazo el correo. Revisa el destinatario y pide una nueva propuesta; no se reintentara automaticamente.');
        let result;
        try { result = await response.json(); } catch { throw uncertain(); }
        if (typeof result?.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(result.id)) throw uncertain();
        return `Gmail acepto el envio para ${email.to}.\nhttps://mail.google.com/mail/u/0/#sent/${result.id}`;
      }
    },
  };
}
