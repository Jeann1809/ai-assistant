import { config } from 'dotenv';
import { authorizeGmail } from '../src/integrations/gmail/authorize.js';
import { GmailError } from '../src/integrations/gmail/http.js';

config({ quiet: true });
try {
  await authorizeGmail();
  console.log('Gmail autorizado con permiso de solo lectura. Ya puedes iniciar el bot.');
} catch (err) {
  console.error(err instanceof GmailError ? err.message : 'No pude autorizar Gmail. Revisa la configuracion y vuelve a intentar.');
  process.exitCode = 1;
}
