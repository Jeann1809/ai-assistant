import 'dotenv/config';
import { logger } from './logger.js';
import { startWhatsApp } from './whatsapp/index.js';

logger.info('assistant starting...');

try {
  await startWhatsApp();
} catch (err) {
  logger.error({ err }, 'failed to start whatsapp connection');
  process.exit(1);
}
