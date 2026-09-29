# Gmail + Canvas (M5)

Uses Node's built-in `fetch`, HTTP server and crypto modules. No new dependencies,
no polling, no Gmail writes. Google receives only the `gmail.readonly` scope;
reading a message does not mark it read. The Desktop flow uses PKCE S256, random
state, a temporary port on `127.0.0.1`, and a three-minute consent timeout.

## Configure locally

1. In your Google Cloud project, enable **Gmail API**. Keep billing disabled,
   especially on the project holding the Gemini key. If the console requires a
   paid setup, stop instead of enabling billing.
2. Configure Google Auth Platform for an **External** audience, publishing status
   **Testing**, and add your personal Gmail account as a test user.
3. Add `https://www.googleapis.com/auth/gmail.readonly` under Data Access.
4. Create an OAuth client of type **Desktop app** under Clients. Copy its client
   ID and client secret into your local `.env`. Do not send credentials in chat.
5. Add these entries to your existing `.env`, without replacing your other keys:

   ```dotenv
   GMAIL_CLIENT_ID=your_desktop_client_id
   GMAIL_CLIENT_SECRET=your_desktop_client_secret
   WHATSAPP_OWNER_NUMBER=your_other_number_with_country_code
   ```

   Replace the owner placeholder with digits including country code, optionally
   starting with `+`, with no spaces. This must be the other phone number that
   messages the linked bot, not the bot's own number. All other senders are ignored.
   Missing/invalid owner configuration stops startup before connecting WhatsApp.

6. Run `npm.cmd run gmail:auth`. Open the printed Google link in a browser on this
   same computer, choose your personal Gmail account, and grant read-only access.
   Do not share the authorization link or callback URL. Expect the terminal to say
   **Gmail autorizado con permiso de solo lectura**. The browser receipt alone
   does not confirm token storage succeeded.
7. Run `npm.cmd start`. No fixed `GMAIL_REDIRECT_URI` is required; an old value in
   `.env` is ignored. The Desktop flow supports a dynamically assigned loopback
   port. See [Google's installed-app OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).

Testing refresh tokens expire after seven days for Gmail scopes. Repeat
`npm.cmd run gmail:auth` when the bot asks. The client refreshes short-lived access
tokens automatically; revoked/expired refresh tokens produce a direct re-auth
message instead of a fabricated mailbox answer.
[Google documents refresh-token expiration here](https://developers.google.com/identity/protocols/oauth2#expiration).

Tokens are atomically saved to ignored `data/token-gmail.json`. Temporary files
are also ignored. Files are created with owner-only permissions on POSIX; on
Windows protect the directory with your account's normal filesystem permissions.
For a headless VM, complete consent on your laptop and transfer the file privately
to the VM, using the same Desktop client configuration. Never commit or paste it.

## Test through WhatsApp

From the allowed other number, send these one at a time, waiting for each reply:

1. **"Busca mis ultimos correos con label:Canvas"**: expect message subjects/IDs,
   or an honest empty result. Search supports Gmail syntax and bounded pagination.
2. **"Lee el primero"**: expect a summary based on that message, with no change to
   its read/unread status. This also exercises conversation memory.
3. **"Que entregas tengo esta semana segun los correos de Canvas?"**: expect a
   summary that separates deadlines, grades and announcements, cites emails, and
   distinguishes actual due dates from email receipt dates. Ambiguous dates or
   timezones should be called out rather than guessed.
4. From an unlisted number, send a normal test message: expect no reply and no
   Gmail access. Groups and messages sent by the linked account are also ignored.

If the Canvas label is missing, the bot asks you to check the account/filter.
If no emails match, it must not claim that you have no pending assignments.

## Limits and privacy

- `gmail_search`: up to 10 metadata results per call (default 5), with a next-page
  token. `gmail_read`: one full message, text capped at 4,000 characters.
- `canvas_digest`: up to 20 messages under the exact Canvas label, received in
  the last 60 days by default (configurable by tool argument, max 365). It flags
  additional pages instead of silently claiming a complete calendar. Use search
  pagination for deeper investigation. A lookback is not the assignment due range.
- Attachments and externally stored MIME parts are omitted. Plain text is
  preferred; HTML-only bodies are converted to text without loading links/images.
  Truncation, omitted parts and snippet-only results are exposed to the model.
- This reads forwarded notifications, not the Canvas assignment database. Old
  notices, forwarding failures, edits and attachments can leave gaps. Confirm
  important deadlines in Canvas itself.
- Requested email text is sent to Gemini for the answer. Answer summaries enter
  local conversation history; raw email tool payloads are not persisted there.
- Tool results are quoted untrusted data. Instructions inside mail or web results
  must not be followed. No send/delete/modify tools exist. Web search is blocked
  within a turn once Gmail is requested, including mixed tool batches. Prompt
  instructions also prohibit putting private mail into web queries; this is not
  a guarantee against every possible prompt-injection attempt across history.
- Gmail calls have a 15-second request timeout and up to three retries with
  exponential backoff and jitter for network failures, 429, rate-limit 403 and 5xx.
  Long Retry-After delays return a friendly failure instead of blocking the chat.
  A 401 triggers one forced refresh. Permanent permission failures request setup
  correction. No response bodies or tokens are logged.
  See [Gmail error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
  and [current quotas](https://developers.google.com/workspace/gmail/api/reference/quota).

## Offline checks

Run `npm.cmd test` (`npm test` outside Windows). Tests use fake tokens, local
loopback callbacks and mocked Google/Gemini responses, without opening your
`.env`, WhatsApp session, real tokens or databases. There is no lint script.
Passing these tests does not verify your live Google consent configuration.
