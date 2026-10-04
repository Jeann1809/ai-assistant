import { Type } from '@google/genai';
import { createCalendarClient } from './client.js';

export const calendarDeclarations = [
  { name: 'calendar_list_events', description: 'Read events in the owner primary Google calendar within an explicit date range. Recurring events are expanded. Paginate when incomplete.',
    parameters: { type: Type.OBJECT, properties: {
      timeMin: { type: Type.STRING, description: 'RFC3339 timestamp with seconds and explicit UTC offset, lower bound on event end.' },
      timeMax: { type: Type.STRING, description: 'RFC3339 timestamp with seconds and explicit UTC offset, exclusive upper bound on event start.' },
      maxResults: { type: Type.INTEGER, description: '1 to 20, default 10.' },
      pageToken: { type: Type.STRING, description: 'nextPageToken returned by a previous call.' },
    }, required: ['timeMin', 'timeMax'] } },
];
export const calendarPrepareDeclaration = {
  name: 'calendar_prepare_create', description: 'Propose creating one event ONLY on explicit owner request. Requires a separate WhatsApp confirmation. No invitations, recurrence or direct writes.',
  parameters: { type: Type.OBJECT, properties: {
    summary: { type: Type.STRING, description: 'Complete title, 1-160 characters.' },
    start: { type: Type.STRING, description: 'RFC3339 with seconds and explicit offset, or YYYY-MM-DD for all-day.' },
    end: { type: Type.STRING, description: 'End after start. For all-day events this is the exclusive next date.' },
    allDay: { type: Type.BOOLEAN, description: 'Default false.' },
    description: { type: Type.STRING, description: 'Optional single-line description, up to 1000 characters.' },
    location: { type: Type.STRING, description: 'Optional place, up to 300 characters.' },
  }, required: ['summary', 'start', 'end'] },
};
export const calendarBatchDeclaration = {
  name: 'calendar_prepare_create_many',
  description: 'Propose 1-5 events together on explicit user request. One WhatsApp confirmation approves the complete batch. Stops on first creation failure; no guests or recurrence.',
  parameters: { type: Type.OBJECT, properties: {
    events: { type: Type.ARRAY, items: calendarPrepareDeclaration.parameters, description: 'Complete events, in creation order. Maximum 5. Never omit requested events silently.' },
  }, required: ['events'] },
};
let client;
export async function runCalendarTool(name, args) {
  if (name !== 'calendar_list_events') throw new Error('Unknown Calendar tool');
  client ??= createCalendarClient();
  return client.list(args);
}
