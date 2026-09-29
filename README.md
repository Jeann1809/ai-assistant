# ai-assistant
Self-hosted WhatsApp AI assistant with Gemini function-calling, Microsoft Graph integration, and long-term memory (RAG). Runs on Oracle Cloud free tier.

Short-term conversation memory is implemented in SQLite using the existing
`better-sqlite3` dependency. `SHORT_TERM_DB_PATH` defaults to
`./data/short-term.sqlite`. Each chat retains 100 exchanges on disk and replays
the latest 10 to Gemini, limiting history size and input token usage. Raw tool
results are not persisted. Messages in the same chat are processed sequentially.

Run offline tests with `npm.cmd test` on Windows (`npm test` elsewhere).
Tests cover memory, OAuth/PKCE, Gmail errors, MIME parsing, owner access control,
and Gemini tool dispatch. No API keys or live services are used; OAuth tests use
a temporary loopback HTTP listener and fake authorization data.
There is no lint script configured.

Manual smoke test:

1. Set `WHATSAPP_OWNER_NUMBER` locally to your other number, including country
   code (digits only, optional `+`), then run `npm.cmd start`.
2. From the incoming private chat used to test the bot, send
   "Mi palabra de prueba es girasol" and wait for its reply.
3. Send "Cual es mi palabra de prueba?". Expect "girasol".
4. Stop with Ctrl+C, restart with `npm.cmd start`, and repeat the question.
   Expect the same answer, proving persistence across restarts.

The listener only accepts incoming private messages from `WHATSAPP_OWNER_NUMBER`.
Outgoing messages, groups and other senders are ignored. A missing or invalid
owner number stops startup. LID messages require Baileys to provide the matching
alternate phone-number JID; an unresolved LID is ignored rather than trusted.

Generation failures are not saved. A failed history read produces a retry
message; a failed save produces a warning. A successful send means WhatsApp
accepted the request, not that the recipient read it. Sending and saving are
not atomic: a crash between them may leave a delivered exchange out of memory.

Gmail and Canvas read tools are implemented. Follow [Gmail setup](docs/gmail.md)
to enable the Gmail API without billing, configure a Desktop OAuth client in
Testing, and run `npm.cmd run gmail:auth`. Live authorization and WhatsApp smoke
testing must be completed locally before considering the integration verified.

The confirmation flow is available through `/probar-confirmacion` in WhatsApp.
Approve with `confirmar CODE`, discard with `cancelar`, or inspect with `pendiente`.
Proposals expire after five minutes or a restart. That command runs a harmless
simulation. See [confirmation setup and tests](docs/confirmation.md).

Gmail sending is implemented behind the same confirmation flow. Authorize it
with `npm.cmd run gmail:auth -- --send`, then ask the bot to send an email with an
explicit recipient, subject and body. It shows the full preview before approval.
The first version supports one recipient and plain text only. See
[send setup and live test](docs/gmail-send.md). Live sending has not yet been verified.
