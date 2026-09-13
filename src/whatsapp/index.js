import { connectWhatsApp } from './connection.js';
import { logger } from '../logger.js';

function extractText(message) {
  return (
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    '[unsupported message type]'
  );
}

export async function startWhatsApp() {
  return connectWhatsApp((message) => {
    logger.info(
      { from: message.key.remoteJid, text: extractText(message) },
      'message received'
    );
  });
}
