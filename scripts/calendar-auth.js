import { config } from 'dotenv';
import { authorizeCalendar } from '../src/integrations/calendar/authorize.js';
import { CalendarError } from '../src/integrations/calendar/http.js';
import { CALENDAR_SCOPE, CALENDAR_WRITE_SCOPE, CALENDAR_METADATA_SCOPE } from '../src/integrations/calendar/auth.js';

config({ quiet: true });
try {
  const writeEnabled = process.argv.includes('--write');
  await authorizeCalendar({ scopes: writeEnabled ? [CALENDAR_WRITE_SCOPE, CALENDAR_METADATA_SCOPE] : [CALENDAR_SCOPE, CALENDAR_METADATA_SCOPE] });
  console.log(writeEnabled
    ? 'Calendar autorizado para lectura y creacion de eventos. Cada creacion requiere confirmacion en WhatsApp.'
    : 'Calendar autorizado con permiso de solo lectura. Ya puedes iniciar el bot.');
} catch (err) {
  console.error(err instanceof CalendarError ? err.message : 'No pude autorizar Calendar. Revisa la configuracion y vuelve a intentar.');
  process.exitCode = 1;
}
