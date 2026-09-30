import { createConfirmations } from './pending.js';
import { createGmailSender, validateEmailAction, describeEmail } from '../integrations/gmail/send.js';
import { GmailError } from '../integrations/gmail/http.js';

// The sender lives here, outside the model's tool dispatcher. Only an approved
// snapshot can reach execute; preparing a proposal performs read-only checks.
export function createConfirmationCommands({ logger, sender = createGmailSender(), factMemory }) {
  const confirmations = createConfirmations({ logger, actions: {
    ...(factMemory ? { memory_save: {
      prepare: (payload) => payload,
      describe: (payload) => factMemory.describeProposal(payload),
      execute: (payload) => factMemory.saveProposal(payload),
    } } : {}),
    demo: {
      prepare: () => ({}),
      describe: () => '*Prueba de confirmacion*\nAccion: ejecutar una simulacion local.\nNo envia correos ni modifica servicios externos.',
      execute: async () => 'Listo, pana: simulacion completada. No se envio ningun correo ni se modifico ningun servicio.',
    },
    gmail_send: {
      prepare: validateEmailAction,
      describe: describeEmail,
      execute: (payload) => sender.send(payload),
      failureMessage: (err) => err instanceof GmailError ? err.message : null,
    },
  } });
  return {
    async proposeMemory(chatId, input, send) {
      if (!factMemory) { await send('La memoria no esta disponible.'); return; }
      let payload;
      try { payload = factMemory.prepareProposal(chatId, input); }
      catch { await send('No pude preparar el recuerdo. Revisa /recuerdos o usa /recordar clave = dato.'); return; }
      if (!payload) { await send('Ese recuerdo ya esta guardado con esa clave.'); return; }
      await confirmations.propose(chatId, 'memory_save', payload, send);
    },
    async handleMessage(chatId, text, send) {
      if (text.trim().toLowerCase() === '/probar-confirmacion') {
        await confirmations.propose(chatId, 'demo', {}, send);
        return true;
      }
      return confirmations.handleMessage(chatId, text, send);
    },
    async proposeEmail(chatId, email, send) {
      // Scope/account lookup never sends a message or creates a Gmail draft.
      let payload;
      try { payload = await sender.prepare(email); }
      catch (err) {
        await send(err instanceof GmailError ? err.message : 'No pude preparar el correo. Intenta de nuevo en un momento.');
        return;
      }
      await confirmations.propose(chatId, 'gmail_send', payload, send);
    },
  };
}
