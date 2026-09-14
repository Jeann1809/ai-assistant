import { logger } from '../logger.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const MAX_RESULTS = 5;

// Tavily's free tier limits change over time — recheck tavily.com/pricing
// before assuming these are still accurate.
export async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set — check your .env file');
  }

  let response;
  try {
    response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, max_results: MAX_RESULTS }),
    });
  } catch (err) {
    throw new Error(`Tavily Search request failed (network error): ${err.message}`);
  }

  if (response.status === 401) {
    throw new Error('Tavily rejected the API key (401) — check TAVILY_API_KEY');
  }
  if (response.status === 429 || response.status === 432) {
    throw new Error(`Tavily rate/plan limit hit (${response.status}) — try again later`);
  }
  if (!response.ok) {
    throw new Error(`Tavily Search returned status ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`Tavily Search returned malformed JSON: ${err.message}`);
  }

  const results = data.results ?? [];
  logger.info({ query, resultCount: results.length }, 'tavily search executed');

  return results.slice(0, MAX_RESULTS).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.content,
  }));
}
