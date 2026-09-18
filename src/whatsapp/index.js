import { connectWhatsApp } from './connection.js';
import { getReply } from '../llm/respond.js';
import { getHistory, saveExchange } from '../memory/short-term.js';
import { logger } from '../logger.js';

function extractText(message) {
  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    '[unsupported message type]'
  );
}

export async function startWhatsApp() {
  return connectWhatsApp(async (message, sock) => {
    const from = message.key.remoteJid;
    const text = extractText(message);

    logger.info({ from, text }, 'message received');

    // don't auto-reply in group chats — this is a personal assistant, not a
    // group bot, and unsolicited group replies risk being flagged as spam
    if (!from || from.endsWith('@g.us')) return;
    if (text === '[unsupported message type]') return;

    // if history can't be read, still answer — just without context — rather
    // than going silent; the error is logged loudly so it doesn't go unnoticed
    let history = [];
    try {
      history = getHistory(from);
    } catch (err) {
      logger.error({ err, from }, 'failed to read short-term memory, answering without history');
    }

    let reply;
    try {
      reply = await getReply(text, history);
    } catch (err) {
      logger.error({ err, from }, 'gemini reply generation failed');
      // fallback text is sent but deliberately NOT saved to memory
      await sendText(sock, from, 'Sorry, I ran into an error generating a reply — try again in a bit.');
      return;
    }

    try {
      saveExchange(from, text, reply);
    } catch (err) {
      logger.error({ err, from }, 'failed to save exchange to short-term memory');
    }

    await sendText(sock, from, reply);
  });
}

async function sendText(sock, to, text) {
  try {
    await sock.sendMessage(to, { text });
  } catch (err) {
    logger.error({ err, to }, 'failed to send whatsapp reply');
  }
}
