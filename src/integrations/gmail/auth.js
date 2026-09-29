import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { GmailError, reauthError, requestJson } from './http.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function getOAuthConfig() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret || clientId.startsWith('your_') || clientSecret.startsWith('your_')) {
    throw new GmailError('CONFIG', 'Configura GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET del cliente Desktop en tu .env.');
  }
  return { clientId, clientSecret };
}

export function createAuthorization(clientId, redirectUri) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return { url: url.toString(), verifier, state };
}

export function createTokenStore(path = './data/token-gmail.json') {
  return {
    async read() {
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value.refresh_token !== 'string' || !value.refresh_token) throw reauthError();
        return value;
      } catch { throw reauthError(); }
    },
    async write(value) {
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new GmailError('STORAGE', 'No pude guardar la autorizacion de Gmail. Revisa los permisos del directorio data.');
      }
    },
  };
}

function normalizeTokens(data, previous = {}, now = Date.now()) {
  const refreshToken = data.refresh_token ?? previous.refresh_token;
  if (typeof data.access_token !== 'string' || !data.access_token ||
      typeof refreshToken !== 'string' || !refreshToken ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      (data.token_type !== undefined && (typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer')) ||
      (data.scope !== undefined && (typeof data.scope !== 'string' || !data.scope.split(' ').includes(GMAIL_SCOPE)))) {
    throw reauthError();
  }
  return { access_token: data.access_token, refresh_token: refreshToken,
    expires_at: now + data.expires_in * 1000 };
}

export function createGmailAuth({ config = getOAuthConfig, store = createTokenStore(),
  request = requestJson, now = Date.now } = {}) {
  let refreshing;
  async function tokenRequest(params) {
    const { clientId, clientSecret } = config();
    return request(TOKEN_URL, { method: 'POST',
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }) });
  }
  return {
    async exchangeCode(code, verifier, redirectUri) {
      const data = await tokenRequest({ grant_type: 'authorization_code', code,
        code_verifier: verifier, redirect_uri: redirectUri });
      await store.write(normalizeTokens(data, {}, now()));
    },
    async getAccessToken(forceRefresh = false) {
      if (refreshing) return refreshing;
      const tokens = await store.read();
      if (!forceRefresh && typeof tokens.access_token === 'string' && tokens.expires_at > now() + 60_000) {
        return tokens.access_token;
      }
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        const updated = normalizeTokens(data, tokens, now());
        await store.write(updated);
        return updated.access_token;
      })();
      try { return await refreshing; } finally { refreshing = undefined; }
    },
  };
}
