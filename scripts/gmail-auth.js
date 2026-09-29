import { config } from 'dotenv';
import { authorizeGmail } from '../src/integrations/gmail/authorize.js';
import { GmailError } from '../src/integrations/gmail/http.js';
import { GMAIL_SCOPE, GMAIL_SEND_SCOPE } from '../src/integrations/gmail/auth.js';

config({ quiet: true });
try {
  const sendEnabled = process.argv.includes('--send');
  await authorizeGmail({ scopes: sendEnabled ? [GMAIL_SCOPE, GMAIL_SEND_SCOPE] : [GMAIL_SCOPE] });
  console.log(sendEnabled
    ? 'Gmail autorizado para lectura y envio. Cada envio requiere confirmacion en WhatsApp.'
    : 'Gmail autorizado con permiso de solo lectura. Ya puedes iniciar el bot.');
} catch (err) {
  console.error(err instanceof GmailError ? err.message : 'No pude autorizar Gmail. Revisa la configuracion y vuelve a intentar.');
  process.exitCode = 1;
}
