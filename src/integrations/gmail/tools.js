import { Type } from '@google/genai';
import { createGmailClient } from './client.js';

export const gmailDeclarations = [
  { name: 'gmail_search', description: 'Search the owner Gmail mailbox, read-only. Returns IDs and metadata; use gmail_read for content. Supports Gmail search syntax and pagination.',
    parameters: { type: Type.OBJECT, properties: {
      query: { type: Type.STRING, description: 'Gmail query, e.g. is:unread or label:Canvas' },
      maxResults: { type: Type.INTEGER, description: '1 to 10, default 5' },
      pageToken: { type: Type.STRING, description: 'nextPageToken from a previous search, if needed' },
    }, required: ['query'] } },
  { name: 'gmail_read', description: 'Read one Gmail message by ID. Does not mark it read. Attachments are omitted and long bodies truncated.',
    parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING, description: 'Message ID returned by gmail_search' } }, required: ['id'] } },
  { name: 'canvas_digest', description: 'Fetch up to 20 recent emails strictly under the Canvas label for an academic digest. ' +
      'Use for deadlines, grades or announcements. Filter actual due dates in the answer, not by email received date. ' +
      'This is incomplete email evidence, not direct access to the Canvas calendar.',
    parameters: { type: Type.OBJECT, properties: {
      lookbackDays: { type: Type.INTEGER, description: 'Days of email history to inspect, 1 to 365, default 60. This is NOT the deadline range.' },
    } } },
];

let client;
export async function runGmailTool(name, args) {
  client ??= createGmailClient();
  if (name === 'gmail_search') return client.search(args);
  if (name === 'gmail_read') return client.readMessage(args?.id);
  if (name === 'canvas_digest') return client.canvasDigest(args);
  throw new Error('Unknown Gmail tool');
}
