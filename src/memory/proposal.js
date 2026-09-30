import { memoryKey, memoryValue } from './long-term.js';

// Proposals must quote the CURRENT owner message, not history, mail or model text.
export function prepareMemoryProposal(input, userText) {
  if (!input || typeof input.key !== 'string' || typeof input.value !== 'string') {
    throw new Error('Memory proposal needs a key and an exact quote');
  }
  const key = memoryKey(input.key);
  const value = memoryValue(input.value);
  if (!userText.includes(value)) throw new Error('Memory value must quote the current user message');
  return { key, value };
}
