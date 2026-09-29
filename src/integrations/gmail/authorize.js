import { createServer } from 'node:http';
import { createAuthorization, createGmailAuth, getOAuthConfig, GMAIL_SCOPE } from './auth.js';
import { GmailError } from './http.js';

// Bound only to loopback, with a short-lived state+PKCE pair. No token/code logs.
export async function authorizeGmail({ auth = createGmailAuth(), config = getOAuthConfig,
  showUrl = (url) => console.log(`Abre este enlace en el navegador de este computador:\n${url}`),
  timeoutMs = 180_000, scopes = [GMAIL_SCOPE] } = {}) {
  const { clientId } = config();
  let session;
  let redirectUri;
  let resolveCallback;
  let rejectCallback;
  let handled = false;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/oauth2callback') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!session || url.searchParams.get('state') !== session.state || handled) {
      res.writeHead(400).end('Solicitud OAuth invalida. Usa el enlace de la terminal.');
      return;
    }
    handled = true;
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      res.writeHead(400).end('Autorizacion cancelada. Puedes volver a ejecutar gmail:auth.');
      rejectCallback(new GmailError('DENIED', 'No se autorizo Gmail. Ejecuta npm.cmd run gmail:auth para intentarlo de nuevo.'));
      return;
    }
    res.end('Codigo recibido. Vuelve a la terminal para comprobar que Gmail quedo autorizado.');
    resolveCallback(url.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new GmailError('LISTEN', 'No pude abrir el puerto local para autorizar Gmail.')));
    server.listen(0, '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => rejectCallback(new GmailError('TIMEOUT',
    'Se agoto el tiempo para autorizar Gmail. Ejecuta npm.cmd run gmail:auth de nuevo.')), timeoutMs);
  try {
    redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
    session = createAuthorization(clientId, redirectUri, scopes);
    showUrl(session.url);
    const code = await callback;
    await auth.exchangeCode(code, session.verifier, redirectUri, scopes);
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
