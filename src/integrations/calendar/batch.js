import { prepareEvent, validateEventAction, describeEvent } from './client.js';
import { CalendarError } from './http.js';

export function prepareEventBatch(input) {
  if (!input || Object.keys(input).some((key) => key !== 'events') ||
      !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 5) {
    throw new CalendarError('ARGUMENT', 'Propone de 1 a 5 eventos por lote.');
  }
  const events = input.events.map(prepareEvent);
  // Ignore property order and equivalent timestamp offsets when detecting
  // duplicate event requests within a single batch.
  const signatures = events.map((event) => JSON.stringify([event.summary, Date.parse(event.start),
    Date.parse(event.end), event.allDay, event.description ?? '', event.location ?? '']));
  if (new Set(signatures).size !== events.length) throw new CalendarError('ARGUMENT', 'El lote contiene eventos repetidos.');
  return events;
}

export function validateEventBatch(input) {
  if (!input || Object.keys(input).some((key) => key !== 'events') || !Array.isArray(input.events) ||
      input.events.length < 1 || input.events.length > 5) {
    throw new CalendarError('ARGUMENT', 'Lote de eventos invalido.');
  }
  const events = input.events.map(validateEventAction);
  prepareEventBatch({ events: events.map(({ calendarId, ...event }) => event) });
  if (new Set(events.map((event) => event.calendarId)).size !== 1) {
    throw new CalendarError('ACCOUNT_CHANGED', 'La cuenta cambio preparando el lote. Pide una nueva propuesta.');
  }
  return { events };
}

export function describeEventBatch(input) {
  const { events } = validateEventBatch(input);
  return events.map((event, index) => `*Evento ${index + 1}/${events.length} del lote*\n${describeEvent(event)}`);
}

export async function createEventBatch(calendar, input) {
  const { events } = validateEventBatch(input);
  const results = [];
  // Calendar cannot create a transactional batch. Stop at the first failure;
  // never retry the entire batch or silently delete already-created events.
  for (const [index, event] of events.entries()) {
    const label = `${index + 1}. ${event.summary} (${event.start})`;
    try {
      await calendar.create(event);
      results.push(`Creado: ${label}`);
    } catch (err) {
      const uncertain = !(err instanceof CalendarError) || err.code === 'CREATE_UNCERTAIN';
      results.push(`${uncertain ? 'Resultado incierto' : 'No creado'}: ${label}`);
      results.push(err instanceof CalendarError ? err.message : 'No pude confirmar el resultado. Revisa Google Calendar antes de repetir este evento.');
      for (let remaining = index + 1; remaining < events.length; remaining++) {
        results.push(`Sin intentar: ${remaining + 1}. ${events[remaining].summary} (${events[remaining].start})`);
      }
      results.push('El lote se detuvo. No repitas los eventos marcados como creados.');
      return results.join('\n');
    }
  }
  return `Lote completado (${events.length} eventos).\n${results.join('\n')}\nhttps://calendar.google.com/`;
}
