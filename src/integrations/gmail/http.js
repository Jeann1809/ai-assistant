export class GmailError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GmailError';
    this.code = code;
  }
}

export const reauthError = () => new GmailError('REAUTH',
  'Parce, toca autorizar Gmail de nuevo. Ejecuta npm.cmd run gmail:auth en tu computador.');

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
      throw new GmailError('UNAVAILABLE', 'Gmail no responde o devolvio datos invalidos. Intenta en un momento.');
    }
    if (response.ok) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new GmailError('MALFORMED', 'Gmail devolvio una respuesta invalida. Intenta de nuevo.');
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
      throw new GmailError('FORBIDDEN', 'Gmail rechazo el acceso. Revisa que la API este habilitada y autoriza gmail.readonly con npm.cmd run gmail:auth.');
    }
    if (response.status === 404) throw new GmailError('NOT_FOUND', 'Ese correo ya no esta disponible en Gmail.');
    throw new GmailError('REQUEST_FAILED', 'No pude completar la consulta de Gmail. Revisa la configuracion OAuth y vuelve a intentar.');
  }
  throw new GmailError('UNAVAILABLE', 'Gmail esta ocupado o alcanzo su limite de consultas. Intenta mas tarde.');
}
