import { connectWhatsApp } from './connection.js';
import { getReply } from '../llm/respond.js';
import { getHistory, saveExchange } from '../memory/short-term.js';
import { createConversationHandler } from '../memory/conversation.js';
import { logger } from '../logger.js';
import { ownerJid, isOwnerMessage } from './owner.js';
import { createConfirmationCommands } from '../confirm/index.js';
import { createFactMemory } from '../memory/facts.js';

export async function startWhatsApp({ longTermStore }) {
  const allowedJid = ownerJid();
  const factMemory = createFactMemory({ store: longTermStore, logger });
  const { handleMessage: handleConfirmation, proposeEmail, proposeMemory } = createConfirmationCommands({ logger, factMemory });
  const handleConversation = createConversationHandler({ getHistory, getReply, saveExchange, logger, handleConfirmation, proposeEmail, proposeMemory, factMemory });
  return connectWhatsApp(async (message, sock) => {
    if (!isOwnerMessage(message, allowedJid)) return;
    const from = message.key.remoteJid;
    const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
    if (!from || from.endsWith('@g.us') || !text) return;

    return handleConversation(allowedJid, text, (reply) => sock.sendMessage(from, { text: reply }));
  });
}
