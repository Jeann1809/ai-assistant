# Propuestas por lote

Branch: `feat/batch-proposals`. Includes the existing uncommitted Calendar feature.
No additional dependencies, OAuth permissions or schema migration.

Ask in natural language for up to **5 events** or **5 memories** in one request.
The assistant uses `calendar_prepare_create_many` or `memory_propose_many`.
One `confirmar CODE` approves the complete batch. Event and memory batches stay
separate; finish or cancel one pending proposal before requesting another.
Single-item proposals and manual `/recordar key = fact` still work.

Each item has its own full preview message. The final message contains the code;
approval is enabled only after every preview and the final message are delivered.
`pendiente` repeats the complete batch without extending its five-minute expiry.
`cancelar`, failed initial delivery and restart discard the entire batch.
The snapshot cannot change after delivery. To change an item, cancel and propose
the complete corrected batch. No partial approval commands are supported.

## Events

- Validate the complete batch before account checks. Reject duplicate events,
  invalid dates, extra fields and lists with more than five entries.
- Show exact title, dates/offsets, destination calendar, location, description and
  default reminder policy for every event. No guests or recurrence.
- Creation runs sequentially and stops at the first failure. Calendar has no
  transactional batch for event creation. Previously created events remain.
- Report each item as **Creado**, **No creado**, **Resultado incierto** or **Sin
  intentar**. Never retry the whole batch or silently roll back external events.
- A timeout or malformed success may mean the failing event exists. Inspect
  Calendar before requesting it again. Only propose remaining events, excluding
  successful ones. The approval is consumed even if WhatsApp loses the result.
- Account identity is checked when preparing each event and before every write.

## Memories

- Every value must quote the current owner message exactly. Retrieved content,
  history and model inventions cannot supply a memory value. Memory proposals
  cannot accompany or follow retrieval in the same model turn.
- Keys must be unique after normalization. Already-saved unchanged values are
  excluded; changed keys show their exact previous and new values.
- After approval, embeddings run sequentially with existing retry/fallback
  behavior. Missing embeddings allow text storage with a warning.
- A single SQLite transaction checks every previous value and the 100-fact limit,
  then saves the whole batch. Stale values, invalid vectors and storage failures
  leave every proposed change unapplied. No database lock spans network calls.

## Test

Run `npm.cmd test`. Offline tests use mocked Calendar calls and fake test memory.
There is no lint script. Real WhatsApp tests remain pending.

Restart the bot with `npm.cmd start`, then send these separate requests:

1. `Crea estos dos eventos el 8 de octubre de 2026: Estudiar de 3 a 4 pm y
   Entrenar de 5 a 6 pm.` Expect two complete previews and one final code.
   Reply `cancelar`: neither event should appear in Calendar.
2. Repeat the request and approve with the final `confirmar CODE`. Expect two
   created results and exactly two matching events. Reusing the code must not
   create duplicates. Calendar consent must already include creation access.
3. `Recuerda estas dos cosas: Estudio en Texas Tech. Prefiero cafe sin azucar.`
   Expect two memory previews with exact quotes and one final code. Confirm,
   then send `/recuerdos` to check both facts. If already saved, the bot skips them.
4. Request a changed value for an existing key plus a new fact. The old/new values
   must appear before confirmation. Cancel to keep both changes unapplied.

To verify partial Calendar failure safely, use the offline tests. Do not deliberately
break credentials or quota on the live account.
