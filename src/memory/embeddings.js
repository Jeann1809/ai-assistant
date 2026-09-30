export const EMBEDDING_MODEL = 'gemini-embedding-2';
export const DIMENSIONS = 768;
export const EMBEDDING_VERSION = `${EMBEDDING_MODEL}:${DIMENSIONS}:retrieval-v1`;

export function normalizeVector(values) {
  if (!Array.isArray(values) || values.length !== DIMENSIONS || !values.every(Number.isFinite)) {
    throw new Error('Invalid memory embedding');
  }
  const magnitude = Math.hypot(...values);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('Invalid memory embedding');
  return values.map((value) => value / magnitude);
}

// A single embedContent request, not the paid Batch API. Read env lazily.
// No payloads, response bodies or API keys are ever included in error messages.
export function createMemoryEmbedder({ fetchImpl = fetch, apiKey = () => process.env.GEMINI_API_KEY,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random,
  now = Date.now } = {}) {
  let unavailableUntil = 0;
  return async function embed(text, kind = 'document') {
    if (now() < unavailableUntil) throw new Error('Memory embeddings temporarily unavailable');
    const key = apiKey();
    if (!key) throw new Error('GEMINI_API_KEY is required for semantic memory');
    const input = kind === 'query' ? `task: search result | query: ${text}` : `title: personal memory | text: ${text}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ model: `models/${EMBEDDING_MODEL}`, content: { parts: [{ text: input }] }, outputDimensionality: DIMENSIONS }),
        });
        if (response.ok) {
          const data = await response.json();
          return normalizeVector(data?.embedding?.values);
        }
      } catch { /* bounded retries below; callers retain local keyword search */ }
      if (response && !response.ok && response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response?.headers.get('retry-after'));
      if (retryAfter > 10) break;
      if (attempt < 2) await sleep(Math.max(1000 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0) + Math.floor(random() * 500));
    }
    unavailableUntil = now() + 60_000;
    throw new Error('Semantic memory unavailable; check Gemini access or retry later');
  };
}
