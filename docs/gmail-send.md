# Confirmed Gmail sending (M7)

The owner can request an email in WhatsApp. Gemini proposes `to`, `subject` and
`body`; the app validates them, fetches the authorized Gmail account, and shows
the complete preview. Only a separate `confirmar CODE` owner message executes
the send. Preparing a proposal does not create a Gmail draft or send anything.

No new dependencies. The first version supports one plain ASCII recipient email
address, a subject up to 160 characters and a plain-text body up to 2,000 characters.
No CC/BCC, attachments, HTML delivery, aliases or threaded replies. These limits
keep the whole approval readable in one WhatsApp message. Oversized content is
rejected rather than silently shortened.

## Enable sending

1. In your existing Google Cloud project, open **Google Auth Platform > Data
   Access** and add `https://www.googleapis.com/auth/gmail.send`, keeping
   `https://www.googleapis.com/auth/gmail.readonly`. Keep billing disabled and
   your existing personal Gmail test user. Use the same Desktop client.
2. Stop the bot and run:

   ```powershell
   npm.cmd run gmail:auth -- --send
   ```

3. Open the printed URL on the same computer, select your personal Gmail, and
   accept both reading and sending. Expect **Gmail autorizado para lectura y
   envio** in the terminal. Do not share tokens or the callback URL.
4. Start the bot with `npm.cmd run dev`. No new `.env` values are needed.

Without `--send`, the command remains read-only. Existing legacy token files are
not assumed to have send permission. Missing permission produces the exact
re-authorization command instead of a pending action. In Testing, re-authorize
with `-- --send` again when the refresh token expires.

The `gmail.send` scope and MIME/base64url format are documented in Google's
[send method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
and [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending).

## Live test

Use a mailbox you control as the recipient. From the allowed WhatsApp number:

1. Send: **"Envia un correo a MI_DIRECCION_REAL, asunto Prueba del bot, cuerpo:
   Este correo prueba el envio con confirmacion."** Replace the address first.
2. Expect a preview showing **De**, **Para**, **Asunto** and the full body, followed
   by a confirmation code. Nothing should appear in Gmail Sent yet.
3. Send `cancelar`. Expect cancellation and no sent email.
4. Request the email again, inspect the new preview, and send `confirmar CODE`
   using its actual code. This step sends a real email.
5. Expect **Gmail acepto el envio** and a link. Check Gmail Sent and the recipient
   inbox. Provider acceptance is not proof of delivery or reading.
6. Repeat the same confirmation. Expect no pending action and no second email.

`pendiente` shows the active preview. A bare yes does not execute. Proposals
expire after five minutes or any process restart. A second proposal cannot
replace one silently. To edit, cancel and request the complete corrected email.

## Failure behavior

- The approved data is copied, then encoded as MIME with base64 UTF-8 body and
  RFC 2047 subject. Headers cannot contain injected newlines or extra recipients.
  The preview is shown as a literal text block; embedded code fences and hiding
  controls are rejected.
- The sender account is displayed and checked again before sending. If OAuth was
  switched to a different Gmail account after the preview, the action is aborted.
- Refresh/profile reads use bounded retries and jitter through the existing
  Gmail client. The non-idempotent send POST deliberately does **not** reuse that
  retry helper: network errors, 429 and 5xx do not cause automatic resends.
- A rejected 401 permits one token refresh and retry of the same MIME message,
  with another account check. Repeated 401 or invalid refresh tokens request
  re-authorization. Permission and quota errors give guidance without a resend.
- Network failure, 5xx, or malformed success responses leave the outcome
  uncertain. Approval is consumed. Check Gmail Sent before requesting another
  proposal, because the first email may already have been sent.
- If WhatsApp fails to deliver the result after sending, the approval stays
  consumed. Never interpret missing chat feedback as proof that no email went out.
- There is no durable execution ledger or exactly-once provider guarantee.
  Pending previews and results are not stored as model conversation history;
  inspect Gmail Sent for the authoritative record of sends.

## Offline checks

Run `npm.cmd test`: expect 60 passing tests. The send tests use fake credentials,
mocked Gmail responses and a simulated conversation, so they send no mail.
They cover consent/scopes, header injection, Unicode MIME, account changes,
401/403/429/503, uncertain outcomes, cancellation and duplicate confirmations.
Live sending still needs the manual test above. No lint script is configured.
