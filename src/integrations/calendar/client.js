import { createCalendarAuth } from './auth.js';
import { CalendarError, requestJson, reauthError } from './http.js';

const API = 'https://www.googleapis.com/calendar/v3/calendars';
const invalid = (message) => new CalendarError('ARGUMENT', message);
const malformed = () => new CalendarError('MALFORMED', 'Calendar devolvio datos incompletos. Intenta de nuevo.');
const uncertain = () => new CalendarError('CREATE_UNCERTAIN',
  'No pude confirmar si se creo el evento. No repetire la creacion. Revisa Google Calendar antes de pedir otra propuesta.');

export function calendarTimeZone() {
  const zone = process.env.CALENDAR_TIME_ZONE || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); }
  catch { throw new CalendarError('CONFIG', 'Configura CALENDAR_TIME_ZONE con una zona IANA valida, por ejemplo America/Chicago.'); }
  return zone;
}

export function validateTime(value, allDay = false) {
  if (typeof value !== 'string') throw invalid('Indica fechas completas para inicio y fin.');
  const pattern = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  const date = value.slice(0, 10);
  if (!pattern.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
      (!allDay && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59))) {
    throw invalid('Usa fechas reales YYYY-MM-DD o timestamps RFC3339 con segundos y zona horaria explicita.');
  }
  return value;
}

export function prepareEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['summary', 'start', 'end', 'allDay', 'description', 'location'].includes(key))) {
    throw invalid('Solo se admiten titulo, inicio, fin, dia completo, descripcion y lugar. Sin invitados ni recurrencia.');
  }
  const hidden = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]|```/u;
  for (const [key, max] of [['summary', 160], ['description', 1000], ['location', 300]]) {
    if ((key === 'summary' || input[key] !== undefined) &&
        (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max || hidden.test(input[key]))) {
      throw invalid(`Usa ${key} de 1 a ${max} caracteres, en una linea y sin controles invisibles.`);
    }
  }
  if (input.allDay !== undefined && typeof input.allDay !== 'boolean') throw invalid('allDay debe ser booleano.');
  const allDay = input.allDay ?? false;
  const start = validateTime(input.start, allDay);
  const end = validateTime(input.end, allDay);
  if (Date.parse(end) <= Date.parse(start)) throw invalid('El fin debe ser posterior al inicio; para dia completo el fin es exclusivo.');
  return { summary: input.summary, start, end, allDay,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}) };
}

export function validateEventAction(input) {
  if (!input || typeof input.calendarId !== 'string' || !input.calendarId || input.calendarId.length > 254 ||
      /[\s\u0000-\u001f`]/u.test(input.calendarId)) throw invalid('Calendario de la propuesta invalido.');
  const { calendarId, ...event } = input;
  return { calendarId, ...prepareEvent(event) };
}

export function describeEvent(input) {
  const event = validateEventAction(input);
  return '*Evento pendiente de creacion*\n```\n' +
    `Calendario: ${event.calendarId}\nTitulo: ${event.summary}\nInicio: ${event.start}\nFin: ${event.end}` +
    (event.allDay ? ' (exclusivo, dia completo)' : ' (zona indicada en cada hora)') +
    `\nLugar: ${event.location ?? '(sin lugar)'}\nDescripcion: ${event.description ?? '(sin descripcion)'}` +
    '\nSin invitados ni recurrencia. Recordatorios predeterminados del calendario.\n```';
}

export function createCalendarClient({ auth = createCalendarAuth(), request = requestJson, fetchImpl = fetch } = {}) {
  async function get(path, params = {}, force = false) {
    const url = new URL(`${API}/${path}`);
    url.search = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.getAccessToken(force || attempt === 1);
      try { return await request(url, { headers: { Authorization: `Bearer ${token}` } }); }
      catch (err) { if (err.code !== 'REAUTH' || attempt === 1) throw err; }
    }
  }
  async function identity(force = false) {
    const calendar = await get('primary', {}, force);
    if (typeof calendar.id !== 'string' || !calendar.id) throw malformed();
    return calendar.id;
  }
  return {
    async list({ timeMin, timeMax, maxResults = 10, pageToken } = {}) {
      validateTime(timeMin); validateTime(timeMax);
      if (Date.parse(timeMax) <= Date.parse(timeMin) || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20 ||
          (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 2000))) {
        throw invalid('Indica un rango valido y maxResults entre 1 y 20.');
      }
      const data = await get('primary/events', { timeMin, timeMax, maxResults: String(maxResults),
        singleEvents: 'true', orderBy: 'startTime', timeZone: calendarTimeZone(), ...(pageToken ? { pageToken } : {}) });
      if (!Array.isArray(data.items) || (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) throw malformed();
      const events = data.items.slice(0, maxResults).map((event) => {
        if (typeof event?.id !== 'string' || !event.start || !event.end) throw malformed();
        validateTime(event.start.dateTime ?? event.start.date, !event.start.dateTime);
        validateTime(event.end.dateTime ?? event.end.date, !event.end.dateTime);
        const text = (key, max) => typeof event[key] === 'string' ? event[key].slice(0, max) : '';
        return { id: event.id, summary: text('summary', 300), start: event.start.dateTime ?? event.start.date,
          end: event.end.dateTime ?? event.end.date, allDay: Boolean(event.start.date),
          location: text('location', 300), description: text('description', 1000) };
      });
      return { events, timeZone: data.timeZone, nextPageToken: data.nextPageToken ?? null,
        incomplete: Boolean(data.nextPageToken), limitation: 'Primary calendar only. Descriptions may be truncated. All-day end dates are exclusive.' };
    },
    async prepare(input) {
      const event = prepareEvent(input);
      await auth.requireWritePermission();
      return validateEventAction({ calendarId: await identity(), ...event });
    },
    async create(input) {
      const event = validateEventAction(input);
      const { calendarId, start, end, allDay, ...fields } = event;
      const body = JSON.stringify({ ...fields, start: allDay ? { date: start } : { dateTime: start },
        end: allDay ? { date: end } : { dateTime: end }, reminders: { useDefault: true } });
      for (let attempt = 0; attempt < 2; attempt++) {
        await auth.requireWritePermission();
        if (await identity(attempt === 1) !== calendarId) throw new CalendarError('ACCOUNT_CHANGED',
          'La cuenta de Calendar cambio desde la propuesta. No cree el evento. Pide una nueva propuesta.');
        const token = await auth.getAccessToken();
        let response;
        try {
          response = await fetchImpl(`${API}/${encodeURIComponent(calendarId)}/events`, {
            method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body, signal: AbortSignal.timeout(15_000),
          });
        } catch { throw uncertain(); }
        // Only an explicit authorization rejection can safely be retried.
        if (response.status === 401) { if (attempt === 0) continue; throw reauthError(); }
        if (response.status === 429) throw new CalendarError('CREATE_LIMIT', 'Calendar limito la creacion. Espera y pide otra propuesta; no se reintentara automaticamente.');
        if (response.status === 403) throw new CalendarError('FORBIDDEN', 'Calendar rechazo la creacion por permisos o cuota. Revisa la API y npm.cmd run calendar:auth -- --write.');
        if (response.status >= 500 || (response.status >= 300 && response.status < 400)) throw uncertain();
        if (!response.ok) throw new CalendarError('CREATE_REJECTED', 'Calendar rechazo el evento. Revisa las fechas y pide una nueva propuesta.');
        let data;
        try { data = await response.json(); } catch { throw uncertain(); }
        if (typeof data?.id !== 'string' || !data.id) throw uncertain();
        return `Listo, Calendar acepto la creacion de: ${event.summary}.\nInicio: ${start}\nFin: ${end}\nhttps://calendar.google.com/`;
      }
    },
  };
}
