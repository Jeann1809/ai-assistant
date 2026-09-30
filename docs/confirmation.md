# Action confirmation (M6)

The application handles confirmation before Gemini and SQLite history. Only
messages that pass the existing WhatsApp owner gate reach it. Tool results and
model replies cannot confirm anything. Gmail sending now uses this same gate;
see [Gmail send setup](gmail-send.md). The simulation never sends email.

## Try it on WhatsApp

1. Run `npm.cmd run dev` and send `/probar-confirmacion` from your allowed number.
2. Expect a *Prueba de confirmacion* summary, a random code and these commands:
   - `confirmar CODE`: approve exactly the displayed proposal, e.g. `confirmar 472`.
   - `cancelar`: discard it.
   - `pendiente`: show it again without extending its lifetime.
3. Send `si`. Expect a reminder to use the full command, with no execution.
4. Send `confirmar CODE` using the actual code. Expect **simulacion completada**.
   No email is sent and no external service is modified.
5. Repeat the same confirmation. Expect **No hay ninguna accion pendiente**.
6. Start another test and send `cancelar`. Its old code must no longer work.
7. Start another test, wait five minutes, then confirm. Expect an expiration
   message. No background expiry notification is sent.

Restarting the process, including a `node --watch` restart after a code change,
also discards proposals. No secrets or configuration changes are needed for M6.

## Design and limitations

- One pending proposal per chat, with a five-minute lifetime starting when the
  preview send succeeds. A new proposal never silently replaces an existing one.
- Codes have three digits (100-999); the last 20 issued per chat are not reused
  during the current process. Codes can recur later or after a restart; they are
  proposal identifiers, not authentication. Access still depends on the owner gate.
- Explicit code matching ties approval to the displayed action. A bare yes,
  embedded command, wrong code or a command from another chat cannot approve it.
- Payloads are validated and cloned before previewing. The handler renders the
  preview from those exact values. Incomplete/oversized previews are rejected,
  never silently truncated. Editing a proposal requires cancellation and a new
  preview with a new code.
- Approval is unavailable until the preview send succeeds. Execution consumes it
  before awaiting work. Duplicate commands cannot invoke the same proposal twice,
  including while its execution is in flight. Cancellation cannot undo an action
  already executing.
- Pending state is held in memory. That keeps a single-user bot simple and makes
  restart behavior fail closed. This is not a durable exactly-once guarantee for
  an external provider or a multi-process deployment.
- Failed execution reports uncertainty, consumes approval and does not retry.
  Failed result delivery also leaves approval consumed. Before making a fresh
  proposal after a failure, check the external service for an already-applied
  action. Future handlers must bound network calls and avoid blind write retries.
- Commands and simulation results do not enter conversation memory, so Gemini
  cannot infer pending state from history. Use `pendiente` for the actual state.
  Ordinary conversation remains available while a proposal is pending.

## Gmail action in M7

`src/confirm/pending.js` accepts a registry of trusted handlers, each with
`prepare(payload)`, `describe(payload)` and `execute(payload)`. Registration is
application code, never a model-supplied function or dynamic import.

`src/confirm/index.js` registers the simulation and `gmail_send`. It exposes
`handleMessage` for incoming commands and `proposeEmail` for validated proposals.
The model only has `gmail_prepare_send`, which returns proposed email data to the
application. It cannot execute an action or confirm one. Sender/account and scope
checks run before showing the complete preview and again before sending. Only
`confirmar CODE` reaches the registered sender. Authorization remains read-only
unless the user opts into `gmail:auth -- --send`.

## Offline verification

Run `npm.cmd test`: all 60 tests should pass, including 15 confirmation tests
and 17 Gmail send tests.
Tests cover expiry, isolation, payload snapshots, duplicate approvals, delivery
failures, execution failures, restart behavior and the conversation integration.
They use simulated actions and do not call Gmail, Gemini or WhatsApp.
