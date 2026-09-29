import { config } from 'dotenv';

config({ quiet: true });
import { logger } from './logger.js';
import { startWhatsApp } from './whatsapp/index.js';
import { initShortTermMemory } from './memory/short-term.js';

logger.info('assistant starting...');

try {
  initShortTermMemory();
} catch (err) {
  logger.error({ err }, 'failed to open short-term memory database');
  process.exit(1);
}

try {
  await startWhatsApp();
} catch (err) {
  logger.error({ err }, 'failed to start whatsapp connection');
  process.exit(1);
}
