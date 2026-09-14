// package.json points @whiskeysockets/baileys at a fork branch
// (doryani-ai/Baileys#fix/companion-reg-refresh) because official releases
// can't complete QR pairing since WhatsApp added a companion_reg_refresh
// step in ~July 2026 (WhiskeySockets/Baileys#2737, unmerged fix in #2765).
// Switch back to the official npm package once that PR lands.
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import { logger } from '../logger.js';

const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || './auth_info_baileys';
const RECONNECT_DELAY_MS = 3000;

export async function connectWhatsApp(onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ module: 'baileys' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('scan this QR code with WhatsApp (Linked Devices) to log in');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('whatsapp connection established');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn({ statusCode, loggedOut }, 'whatsapp connection closed');

      if (loggedOut) {
        logger.error(
          `session logged out — delete ${AUTH_DIR} and restart to re-scan the QR code`
        );
        return;
      }

      // fixed delay avoids a tight reconnect loop hammering WhatsApp if the
      // connection keeps failing immediately (ban risk on an unofficial client)
      setTimeout(() => connectWhatsApp(onMessage), RECONNECT_DELAY_MS);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' || !onMessage) return;

    for (const message of messages) {
      if (message.key.fromMe || !message.message) continue;
      onMessage(message, sock);
    }
  });

  return sock;
}
