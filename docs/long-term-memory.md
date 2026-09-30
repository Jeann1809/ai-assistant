# Long-term memory (M8)

The owner stores facts in SQLite using commands or by confirming a model proposal. Ordinary questions automatically
retrieve up to three relevant facts, even after restarting or after those facts
leave the recent conversation window. Email, web content and model output never
write to this memory. No new dependencies or credentials are required.

## Commands

Send these from the allowed WhatsApp number:

```text
/recordar universidad = Estudio Computer Science en Texas Tech
/recordar materia = Estoy cursando algoritmos
/recuerdos
/recordar materia = Estoy cursando bases de datos
/olvidar materia
```

- Reusing the same key corrects/replaces the prior value, including its vector.
- Keys allow 1-40 letters, numbers, underscores or hyphens, with no spaces.
  Keys are case-insensitive. Values allow 1-300 characters on one line.
- `/recuerdos 2` shows the next page (five facts per page).
- At most 100 facts per chat. No automatic extraction, eviction or inferred
  corrections. If facts conflict under different keys, correct/delete them.
- Ordinary phrases such as "remember this" can produce a proposal. Gemini may
  also suggest a durable preference, course or project volunteered in the current
  message. It must quote the fact exactly, without inferring missing details.
  The app displays the key, new text and any previous value it would replace.
  Use `confirmar CODE` to save, `cancelar` to decline, or `pendiente` to inspect.
  A bare yes does not authorize it. Proposals expire after five minutes or restart
  and share the single pending-action slot with email sending. Nothing is saved
  or embedded for storage until confirmation. An intervening manual edit blocks
  the stale proposal. Identical key/value pairs are not proposed again.
- The model cannot claim it stored anything. Commands bypass Gemini generation
  and conversation history, though saving requests an embedding.
- `/olvidar key` removes the fact and vector from long-term memory only. Existing
  chat-history mentions, WhatsApp messages, backups and provider-side copies are
  not erased. A correction also does not rewrite old conversation transcripts.

## Test locally

1. Run `npm.cmd run dev` with your existing configuration.
2. Send `/recordar universidad = Estudio en Texas Tech`. Expect **Recuerdo guardado**.
3. Send `/recuerdos`. Expect the saved key and exact text.
4. Ask **"En que universidad estudio?"**. Expect an answer using Texas Tech.
5. Stop the bot with Ctrl+C, restart with `npm.cmd run dev`, then send `/recuerdos`.
   The fact must still be there. Ask the question again.
6. Correct the value with `/recordar universidad = Estudio en una universidad de prueba`.
   `/recuerdos` must show only the replacement for that key.
7. Send `/olvidar universidad`. `/recuerdos` must no longer list it. The model may
   still see earlier mentions in recent chat history, as explained above.

If embeddings are unavailable, the command still saves the text and tells you
that keyword search will be used. Repeat `/recordar key = value` later to index a
text-only fact. Listing, correcting and deleting remain available without the
embedding service (correction saves text if embedding fails).

`npm.cmd test` runs 80 offline tests, including 13 memory tests and seven hybrid
proposal tests. It exercises
real sqlite-vec with synthetic vectors, temporary databases and fake HTTP
responses. It does not open your personal database or call the live Gemini API.
Live embedding quality/access still needs the manual test above. No lint script
is configured.

## Why this design

- Existing `better-sqlite3` + `sqlite-vec` dependencies. Text and vector live in
  one normal SQLite row, so corrections and deletes are atomic. Scalar
  `vec_distance_cosine` scans only the current chat's rows. With at most 100 rows,
  a separate vector index/table is unnecessary complexity.
- `LONG_TERM_DB_PATH` defaults to ignored `./data/long-term.sqlite`. Missing
  directories are created. Extension/database initialization failure stops boot
  with a diagnostic instead of silently pretending memory works.
- Embeddings use pinned `gemini-embedding-2`, 768 normalized float dimensions,
  and retrieval-specific input formatting. Model, dimension and prompt version
  are tagged on rows; incompatible vectors are not compared after a future
  version change. Such rows still support keyword search until resaved.
- Google lists standard Embedding 2 text requests as free-tier eligible. Keep
  the Gemini project without billing. This uses individual `embedContent`
  requests, not the paid Batch API. See [pricing](https://ai.google.dev/gemini-api/docs/pricing)
  and [embedding input format](https://ai.google.dev/gemini-api/docs/embeddings).
- A nonempty store adds one embedding request per ordinary question, plus one
  per save/correction. No requests for empty memory, listing, deleting or
  confirmation commands. Requests have a 10-second timeout, up to two retries
  with backoff and jitter for network/429/5xx/malformed replies, and a 60-second
  cooldown after failure. Permanent authorization errors are not retried.
- Keyword matches are ranked first, then cosine matches within distance 0.6,
  deduplicated and capped at three. The distance cutoff is a starting heuristic,
  not a confidence score or an empirically calibrated guarantee of relevance.
  Recall uses the current question, so vague follow-ups rely on short-term history.
- Embedding failures fall back to local keyword search with a visible warning.
  Database read failures yield no facts and a warning. Failed writes never claim
  success. Logs omit fact text, vectors, API keys and provider response bodies.

## Privacy and trust

Saving sends the fact text to Google's embedding endpoint; ordinary questions
also go there for retrieval. Selected facts are sent to Gemini with the current
question as quoted untrusted data, never system instructions. They cannot confer
permission to send mail or bypass confirmation. Do not store credentials here.
Google's free-tier data-use terms apply; the pricing page describes those terms.

Memory contains user assertions, not verified facts. Current user corrections
take precedence in the prompt. Gemini only has a proposal tool, not a memory-write
tool. Code requires an exact quote from the current owner message and rejects
proposals after or alongside retrieval tools. Prompt instructions also exclude
third-party quotations, jokes, secrets and transient details. Deciding whether a
fact is useful remains a model judgment; confirmation is the final check. A retrieved
email cannot silently become a permanent fact.
This does not guarantee immunity to all prompt-injection attacks in generated
answers; the application's separate confirmation gate remains necessary.
