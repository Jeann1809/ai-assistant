import { GoogleGenAI } from '@google/genai';

let client;

export function getClient() {
  if (client) return client;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set — check your .env file');
  }

  client = new GoogleGenAI({ apiKey });
  return client;
}
