import { config } from 'dotenv';

config({ quiet: true });
import { logger } from './logger.js';
import { startWhatsApp } from './whatsapp/index.js';
import { initShortTermMemory } from './memory/short-term.js';
import { openLongTermMemory } from './memory/long-term.js';

logger.info('assistant starting...');

let longTermStore;
try {
  initShortTermMemory();
  longTermStore = openLongTermMemory();
} catch (err) {
  logger.error('failed to initialize conversation memory; check database paths and sqlite-vec installation');
  process.exit(1);
}

try {
  await startWhatsApp({ longTermStore });
} catch (err) {
  logger.error({ err }, 'failed to start whatsapp connection');
  process.exit(1);
}
