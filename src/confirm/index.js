import { createCalendarClient, validateEventAction, describeEvent } from '../integrations/calendar/client.js';
import { CalendarError } from '../integrations/calendar/http.js';
import { prepareEventBatch, validateEventBatch, describeEventBatch, createEventBatch } from '../integrations/calendar/batch.js';
import { createConfirmations } from './pending.js';
import { createGmailSender, validateEmailAction, describeEmail } from '../integrations/gmail/send.js';
import { GmailError } from '../integrations/gmail/http.js';

// The sender lives here, outside the model's tool dispatcher. Only an approved
// snapshot can reach execute; preparing a proposal performs read-only checks.
export function createConfirmationCommands({ logger, sender = createGmailSender(), factMemory, calendar = createCalendarClient() }) {
  const confirmations = createConfirmations({ logger, actions: {
    ...(factMemory ? { memory_save: {
      prepare: (payload) => payload,
      describe: (payload) => factMemory.describeProposal(payload),
      execute: (payload) => factMemory.saveProposal(payload),
    }, memory_save_many: {
      prepare: (payload) => payload,
      describe: (payload) => factMemory.describeProposals(payload),
      execute: (payload) => factMemory.saveProposals(payload),
    } } : {}),
    demo: {
      prepare: () => ({}),
      describe: () => '*Prueba de confirmacion*\nAccion: ejecutar una simulacion local.\nNo envia correos ni modifica servicios externos.',
      execute: async () => 'Listo, pana: simulacion completada. No se envio ningun correo ni se modifico ningun servicio.',
    },
    calendar_create: {
      prepare: validateEventAction,
      describe: describeEvent,
      execute: (payload) => calendar.create(payload),
      failureMessage: (err) => err instanceof CalendarError ? err.message : null,
    },
    calendar_create_many: {
      prepare: validateEventBatch,
      describe: describeEventBatch,
      execute: (payload) => createEventBatch(calendar, payload),
      failureMessage: (err) => err instanceof CalendarError ? err.message : null,
    },
    gmail_send: {
      prepare: validateEmailAction,
      describe: describeEmail,
      execute: (payload) => sender.send(payload),
      failureMessage: (err) => err instanceof GmailError ? err.message : null,
    },
  } });
  return {
    async proposeEvents(chatId, events, send) {
      let payload;
      try {
        const validated = prepareEventBatch({ events });
        const prepared = [];
        for (const event of validated) prepared.push(await calendar.prepare(event));
        payload = validateEventBatch({ events: prepared });
      } catch (err) {
        await send(err instanceof CalendarError ? err.message : 'No pude preparar el lote de eventos. No cree ninguno.');
        return;
      }
      await confirmations.propose(chatId, 'calendar_create_many', payload, send);
    },
    async proposeMemories(chatId, memories, send) {
      if (!factMemory) { await send('La memoria no esta disponible.'); return; }
      let payload;
      try { payload = factMemory.prepareProposals(chatId, memories); }
      catch { await send('No pude preparar el lote. Usa de 1 a 5 recuerdos con claves distintas y revisa el limite de 100 recuerdos.'); return; }
      if (!payload.memories.length) { await send('Todos esos recuerdos ya estan guardados.'); return; }
      await confirmations.propose(chatId, 'memory_save_many', payload, send);
    },
    async proposeEvent(chatId, event, send) {
      let payload;
      try { payload = await calendar.prepare(event); }
      catch (err) {
        await send(err instanceof CalendarError ? err.message : 'No pude preparar el evento. Intenta de nuevo.');
        return;
      }
      await confirmations.propose(chatId, 'calendar_create', payload, send);
    },
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
