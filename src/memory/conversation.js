import { GmailError } from '../integrations/gmail/http.js';

// Serialize read/generate/send/save per chat so follow-ups see the last answer.
export function createConversationHandler({ getHistory, getReply, saveExchange, logger }) {
  const pending = new Map();

  async function respond(chatId, text, send) {
    let history;
    try {
      history = getHistory(chatId);
    } catch {
      logger.error('failed to read short-term memory');
      await send('No pude leer el historial. Intenta de nuevo en un momento.');
      return;
    }
    let reply;
    try {
      reply = await getReply(text, history);
    } catch (err) {
      logger.error('reply generation failed');
      await send(err instanceof GmailError ? err.message : 'No pude generar una respuesta. Intenta de nuevo en un momento.');
      return;
    }
    // Only remember answers accepted by WhatsApp.
    await send(reply);
    try {
      saveExchange(chatId, text, reply);
    } catch {
      logger.error('failed to save short-term memory');
      await send('No pude guardar este intercambio; puede faltar contexto en tu siguiente pregunta.');
    }
  }

  return function handleConversation(chatId, text, send) {
    const previous = pending.get(chatId) ?? Promise.resolve();
    const current = previous.then(() => respond(chatId, text, send)).catch(() => {
      // A failed send must not block later messages or escape the event handler.
      logger.error('failed to send conversation reply');
    });
    pending.set(chatId, current);
    return current.finally(() => {
      if (pending.get(chatId) === current) pending.delete(chatId);
    });
  };
}
