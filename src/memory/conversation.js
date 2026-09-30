import { GmailError } from '../integrations/gmail/http.js';

// Serialize read/generate/send/save per chat so follow-ups see the last answer.
export function createConversationHandler({ getHistory, getReply, saveExchange, logger, handleConfirmation, proposeEmail, proposeMemory, factMemory }) {
  const pending = new Map();

  async function respond(chatId, text, send) {
    // Handle real owner commands before loading model history. Retrieved text
    // and model replies never enter this path; confirmations use no Gemini quota.
    if (handleConfirmation && await handleConfirmation(chatId, text, send)) return;
    if (factMemory && await factMemory.handleMessage(chatId, text, send)) return;
    let history;
    try {
      history = getHistory(chatId);
    } catch {
      logger.error('failed to read short-term memory');
      await send('No pude leer el historial. Intenta de nuevo en un momento.');
      return;
    }
    const recalled = factMemory ? await factMemory.recall(chatId, text) : { facts: [] };
    let reply;
    try {
      reply = await getReply(text, history, { memories: recalled.facts });
    } catch (err) {
      logger.error('reply generation failed');
      await send(err instanceof GmailError ? err.message : 'No pude generar una respuesta. Intenta de nuevo en un momento.');
      return;
    }
    if (reply?.action === 'memory_propose') {
      if (proposeMemory) await proposeMemory(chatId, reply.memory, send);
      else await send('La memoria no esta disponible.');
      return;
    }
    if (reply?.action === 'gmail_prepare_send') {
      if (recalled.warning) await send(recalled.warning);
      if (!proposeEmail) {
        await send('El envio de correos no esta disponible en este chat.');
        return;
      }
      // The deterministic preview replaces model prose. It is not an executed
      // action and must not be saved as a successful model answer.
      await proposeEmail(chatId, reply.email, send);
      return;
    }
    // Only remember answers accepted by WhatsApp.
    await send(reply + (recalled.warning ? `\n\n${recalled.warning}` : ''));
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
