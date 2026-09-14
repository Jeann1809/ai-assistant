import { connectWhatsApp } from './connection.js';
import { getReply } from '../llm/respond.js';
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

    const reply = await getReply(text);

    try {
      await sock.sendMessage(from, { text: reply });
    } catch (err) {
      logger.error({ err, from }, 'failed to send whatsapp reply');
    }
  });
}
