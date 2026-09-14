import { ApiError } from '@google/genai';
import { getClient } from './client.js';
import { logger } from '../logger.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500;
  return true; // network-level failure (no HTTP status) — worth a retry
}

// Gemini free tier RPM/TPM limits change over time — recheck ai.google.dev
// before assuming these retry counts/delays are still reasonable.
export async function generateReply({ contents, tools, toolConfig, systemInstruction } = {}) {
  const ai = getClient();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: { tools, toolConfig, systemInstruction },
      });

      if (typeof response?.text !== 'string' && !response?.functionCalls?.length) {
        throw new Error('Gemini returned an empty or malformed response');
      }

      return response;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw new Error(`Gemini rejected the API key (status ${err.status}) — check GEMINI_API_KEY`);
      }

      const attemptsLeft = attempt < MAX_RETRIES;
      if (isRetryable(err) && attemptsLeft) {
        const delay = BASE_RETRY_DELAY_MS * 2 ** attempt;
        logger.warn({ attempt, delay, err: err.message }, 'gemini call failed, retrying');
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }
}
