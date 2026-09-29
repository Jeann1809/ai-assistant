import { connectWhatsApp } from './connection.js';
import { getReply } from '../llm/respond.js';
import { getHistory, saveExchange } from '../memory/short-term.js';
import { createConversationHandler } from '../memory/conversation.js';
import { logger } from '../logger.js';
import { ownerJid, isOwnerMessage } from './owner.js';

export async function startWhatsApp() {
  const allowedJid = ownerJid();
  const handleConversation = createConversationHandler({ getHistory, getReply, saveExchange, logger });
  return connectWhatsApp(async (message, sock) => {
    if (!isOwnerMessage(message, allowedJid)) return;
    const from = message.key.remoteJid;
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
    if (!from || from.endsWith('@g.us') || !text) return;

    return handleConversation(allowedJid, text, (reply) => sock.sendMessage(from, { text: reply }));
  });
}
