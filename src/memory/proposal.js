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

export function prepareMemoryProposals(input, userText) {
  if (!input || Object.keys(input).some((key) => key !== 'memories') ||
      !Array.isArray(input.memories) || input.memories.length < 1 || input.memories.length > 5) {
    throw new Error('Propone entre 1 y 5 recuerdos por lote.');
  }
  const memories = input.memories.map((memory) => prepareMemoryProposal(memory, userText));
  if (new Set(memories.map((memory) => memory.key)).size !== memories.length) {
    throw new Error('Cada recuerdo del lote debe tener una clave distinta.');
  }
  return memories;
}
