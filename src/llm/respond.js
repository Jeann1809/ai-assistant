import { createModelContent, createPartFromFunctionResponse, createUserContent, Type } from '@google/genai';
import { generateReply } from './generate.js';
import { tavilySearch } from './webSearch.js';
import { logger } from '../logger.js';

function buildSystemInstruction() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    `Today's date is ${today}. ` +
    'You are a personal WhatsApp assistant. Reply concisely and conversationally, ' +
    'like a chat message, not a formal document. Use the web_search tool when a ' +
    'question needs current or factual information you are not confident about — ' +
    "you already know today's date, so never search just to find that out."
  );
}

const WEB_SEARCH_TOOL = {
  functionDeclarations: [
    {
      name: 'web_search',
      description: 'Search the web for current or factual information.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'The search query' },
        },
        required: ['query'],
      },
    },
  ],
};

const MAX_TOOL_HOPS = 3;

// Turns a raw WhatsApp message into a Gemini reply. Gemini decides whether it
// needs to search the web (via Tavily) and, if so, we run the search and hand
// the results back for a follow-up turn. `history` is the recent conversation
// from short-term memory ({ role: 'user' | 'model', text }, oldest first).
// Throws on failure — the caller decides what to tell the user, and must not
// store an error message as if it were a real answer.
export async function getReply(userText, history = []) {
  const systemInstruction = buildSystemInstruction();
  const contents = [
    ...history.map((m) => (m.role === 'user' ? createUserContent(m.text) : createModelContent(m.text))),
    createUserContent(userText),
  ];

  let response = await generateReply({
    contents,
    systemInstruction,
    tools: [WEB_SEARCH_TOOL],
  });

  let hops = 0;
  while (response.functionCalls?.length && hops < MAX_TOOL_HOPS) {
    hops++;
    const call = response.functionCalls[0];

    let toolResponse;
    try {
      const results = await tavilySearch(call.args?.query ?? userText);
      toolResponse = { output: results };
    } catch (err) {
      logger.error({ err }, 'tavily search failed');
      toolResponse = { error: err.message };
    }

    contents.push(createModelContent(response.candidates[0].content.parts));
    contents.push(
      createUserContent([
        createPartFromFunctionResponse(call.id ?? call.name, call.name, toolResponse),
      ])
    );

    response = await generateReply({ contents, systemInstruction, tools: [WEB_SEARCH_TOOL] });
  }

  // hit the hop cap while gemini still wanted to search — cut off tool
  // access and force a text answer from whatever it already gathered,
  // rather than leaving it hanging with no reply
  if (response.functionCalls?.length) {
    logger.warn({ hops }, 'hit max tool hops, forcing a text-only final answer');
    const call = response.functionCalls[0];
    contents.push(createModelContent(response.candidates[0].content.parts));
    contents.push(
      createUserContent([
        createPartFromFunctionResponse(call.id ?? call.name, call.name, {
          error: 'No more searches available — answer with what you already found.',
        }),
      ])
    );
    response = await generateReply({ contents, systemInstruction });
  }

  if (!response.text) {
    throw new Error('Gemini returned no text');
  }

  return response.text;
}
