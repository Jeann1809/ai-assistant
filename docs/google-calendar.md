# Google Calendar

Branch: `feat/google-calendar`. No new dependencies. Uses built-in fetch/crypto/http,
Desktop OAuth with PKCE and the existing WhatsApp confirmation gate.

## Setup

1. Enable **Google Calendar API** in the Cloud project containing your Gmail Desktop
   OAuth client. Keep billing disabled. Add Calendar scopes to the OAuth consent
   configuration if needed and keep your personal account as a test user.
2. The integration reuses `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`. Optional
   `CALENDAR_CLIENT_ID` and `CALENDAR_CLIENT_SECRET` select a different Desktop client.
3. Set `CALENDAR_TIME_ZONE` in your local `.env`. Default: `America/Chicago` for TTU.
   Use `America/Bogota` if your requests should use Colombia time. The model receives
   this zone, today's date in that zone and the current UTC instant.
4. Run `npm.cmd run calendar:auth -- --write`, open the printed link on the same
   computer, choose your account and accept the permissions. Expect
   `Calendar autorizado para lectura y creacion de eventos`.
   For reading only: `npm.cmd run calendar:auth`.
5. Run `npm.cmd start`.

The token is stored separately in ignored `data/token-calendar.json`. Gmail's token
file is unchanged. Never paste tokens into chat. An expired/revoked refresh token
produces a reauthorization message; use `-- --write` again to retain creation access.
For a headless VM, perform consent on your laptop then securely transfer the token,
or use SSH forwarding for the loopback callback.

## Behavior and limits

- Reads only the primary calendar, on demand, with an explicit time range. Returns
  10 events by default, at most 20 per call, with pagination. Recurrences are expanded.
  Descriptions are capped at 1000 characters; incomplete results are reported.
- Creates timed or all-day events, up to five in one confirmed batch. Timed timestamps require explicit offsets;
  the assistant must ask for missing date/time/duration rather than invent them.
  Offsets depend on the event date, including daylight saving time.
- All-day end dates are exclusive: October 6 only uses start October 6, end October 7.
- No guests, invitations, recurrence, attachments, editing or deletion tools.
  Events inherit the calendar's default reminders.
- OAuth requests `calendar.events.owned.readonly`, or `calendar.events.owned` for
  creation, plus `calendar.calendars.readonly` to verify the destination account.
  Google's write scope also permits editing/deleting owned-calendar events, but
  the application exposes only creation. Metadata scope is read-only.
- Batch behavior: [batch-proposals.md](batch-proposals.md).
- Gemini returns a proposal, never an executable write. The application renders the
  complete calendar ID, title, dates, location, description and reminder policy.
  Only `confirmar CODE` executes. `cancelar` discards it; `pendiente` shows it.
  The same one-action slot and five-minute expiry apply to email and memory proposals.
- The destination calendar ID is checked again before creation. Changing accounts
  aborts the write. Approval is consumed even on failure or lost WhatsApp delivery.
- Reads retry network/429/5xx with bounded exponential backoff and jitter. Writes
  retry only after explicit 401 rejection; timeouts/429/5xx never automatically repeat
  a creation. For uncertain outcomes, inspect Calendar before proposing another event.
- Calendar text enters Gemini as quoted untrusted data. Web search is blocked in
  a batch containing calendar reads and after calendar access, to reduce data leaks.

Separate OAuth/HTTP modules follow the existing integration pattern; duplication
keeps Gmail behavior stable without a premature shared abstraction.

## Test

`npm.cmd test` runs offline tests using fake tokens and mocked APIs. No real events
are created. There is no lint script in this repository.

Live smoke test after authorization:

1. Ask WhatsApp: `Que eventos tengo manana?` Expect your primary-calendar events,
   or a clear empty-range result, with dates interpreted in `CALENDAR_TIME_ZONE`.
2. Ask: `Crea un evento Prueba del bot el 6 de octubre de 2026 de 3 a 4 pm`.
   Expect an exact preview with the destination calendar and UTC offsets. Nothing
   should appear in Calendar yet. Reply `cancelar` and verify nothing was created.
3. Repeat the request and send the displayed `confirmar CODE`. Expect a success
   message and exactly one matching event in Google Calendar.
4. Send the same confirmation again. Expect no pending action and no duplicate.
5. Ask for a full-day event. Check the preview's exclusive end date before confirming.

Live consent and smoke test require the owner's browser/WhatsApp and remain pending.

Official references: [scopes](https://developers.google.com/workspace/calendar/api/auth),
[list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).
