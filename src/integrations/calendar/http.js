export class CalendarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

export const reauthError = () => new CalendarError('REAUTH',
  'Parce, toca autorizar Calendar de nuevo. Ejecuta npm.cmd run calendar:auth en tu computador; agrega -- --write si quieres crear eventos.');

// Never expose response bodies: they may contain tokens, mailbox data or HTML.
export async function requestJson(url, options = {}, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    let data;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
      data = await response.json();
    } catch {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt + Math.floor(random() * 500));
        continue;
      }
      throw new CalendarError('UNAVAILABLE', 'Calendar no responde o devolvio datos invalidos. Intenta en un momento.');
    }
    if (response.ok) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new CalendarError('MALFORMED', 'Calendar devolvio una respuesta invalida. Intenta de nuevo.');
      }
      return data;
    }
    if (data?.error === 'invalid_grant' || response.status === 401) throw reauthError();
    const limited = response.status === 429 || (response.status === 403 &&
      data?.error?.errors?.some((item) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(item.reason)));
    if (limited || response.status >= 500) {
      if (attempt < 3) {
        const retryAfter = Number(response.headers.get('retry-after'));
        if (retryAfter > 30) break; // do not hold the chat open for a long quota cooldown
        await sleep(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
          1000 * 2 ** attempt) + Math.floor(random() * 500));
        continue;
      }
      break;
    }
    if (response.status === 403) {
      throw new CalendarError('FORBIDDEN', 'Calendar rechazo el acceso. Revisa que la API este habilitada y autoriza Calendar con npm.cmd run calendar:auth.');
    }
    if (response.status === 404) throw new CalendarError('NOT_FOUND', 'Ese calendario o evento ya no esta disponible.');
    throw new CalendarError('REQUEST_FAILED', 'No pude completar la consulta de Calendar. Revisa la configuracion OAuth y vuelve a intentar.');
  }
  throw new CalendarError('UNAVAILABLE', 'Calendar esta ocupado o alcanzo su limite de consultas. Intenta mas tarde.');
}
