# WhatsApp Personal Assistant — Project Guide

Personal project for a CS student at Texas Tech. Solo-maintained, built incrementally, pushed to GitHub commit by commit. Optimize for simplicity and things I can defend in interviews, not cleverness.

## Tech Stack

- **Backend**: Node.js
- **WhatsApp**: `@whiskeysockets/baileys` (unofficial client, no Chromium needed, lower RAM than whatsapp-web.js)
- **LLM**: Gemini API, current Flash model, function calling / tool use
- **Web search**: Tavily Search API, called as a Gemini function-calling tool (not Gemini's built-in Google Search grounding — see Known deviation below)
- **Integrations**:
  - Gmail API (read/send mail) — OAuth 2.0 + PKCE, personal Google account
  - Microsoft Graph API (mail, calendar, OneDrive) — OAuth 2.0 + PKCE, personal Microsoft account
- **Memory**:
  - Short-term conversation history → SQLite
  - Long-term fact memory / RAG → SQLite + `sqlite-vec` extension
- **Hosting**: Oracle Cloud Always Free (Ampere A1 ARM, Ubuntu), 1 OCPU / 6GB
- **Process manager**: systemd (or PM2 for easier logs/auto-restart)

## Non-Negotiable Rules

1. **Error handling is mandatory.** Every external call (Gemini, Gmail, Graph, Baileys) must handle: network failure, rate limit / 429, expired/invalid token, malformed response. No bare try/catch that just logs and swallows.
2. **Explain the "why."** When proposing an architecture or library choice, briefly state the tradeoff, not just the implementation.
3. **Confirmation before real-world actions.** Any action with a side effect outside the chat (send email, create calendar event, delete file, etc.) must be confirmed by me in WhatsApp before executing. No silent writes. This applies equally to Gmail and Graph actions.
4. **Be honest about risk/limits.** Call out WhatsApp ban risk (unofficial client), Gemini free tier limits, Google Cloud billing gotchas, Gmail API quota limits, Oracle free tier gotchas, whenever relevant.
5. **Gemini API key must stay on a Google Cloud project with NO billing enabled.**
6. **Gmail OAuth client**: installed-app type, Authorization Code + PKCE flow, no client secret required. Keep the OAuth consent screen in "Testing" mode with only my own account as a test user, no need to submit for Google verification.
7. **Microsoft Graph app registration**: "Accounts in any organizational directory and personal Microsoft accounts", public client, Authorization Code + PKCE flow (no client secret, no device code flow).
8. **Simplicity over unnecessary complexity.** No premature abstraction, no extra services/frameworks unless clearly justified. Gmail and Graph get separate, independent tool modules rather than a forced shared "email provider" abstraction until there's real evidence one is needed.

## Working Style

- Build **one feature per session/branch**. Don't ask for "the whole bot" in one go.
- Prefer small, reviewable diffs over large rewrites.
- Every feature should reach a runnable/testable state before moving to the next.
- Commit to GitHub after each working increment (see Git Workflow below).

## Git Workflow

- `main` branch stays deployable.
- Feature branches: `feat/<short-name>` (e.g. `feat/baileys-connection`, `feat/gemini-client`, `feat/gmail-auth`, `feat/graph-auth`).
- Commit messages: short, imperative, no fluff (`add reconnect logic to baileys client`, not `Updated some stuff`).
- `.env`, any token/session storage (`auth_info_baileys/`, `token*.json`, `*.db`, `*.sqlite`) must be in `.gitignore` — never commit secrets, OAuth tokens, or WhatsApp session data.
- Push after each feature reaches a working state, not mid-feature.

## Project Structure (target)

```
/src
  /whatsapp      # Baileys client, connection, message handlers
  /llm           # Gemini client wrapper, function-calling tool definitions
  /integrations
    /gmail       # Gmail OAuth (PKCE) + mail read/send calls
    /graph       # MS Graph OAuth (PKCE) + mail/calendar/onedrive calls
  /memory
    short-term.js  # SQLite conversation history
    long-term.js   # sqlite-vec fact storage/retrieval
  /confirm       # pending-action confirmation flow
  index.js        # entrypoint, wiring everything together
/deploy
  systemd.service # or pm2 ecosystem config
.env.example
.gitignore
CLAUDE.md
README.md
```

## Build Order

1. [x] Project skeleton + config + `.env.example`
2. [x] Baileys connection (QR auth, reconnect logic, message listener)
3. [x] Gemini client wrapper (function calling, error/rate-limit handling)
4. [x] SQLite short-term memory
5. [ ] sqlite-vec long-term memory — **next up**
6. [ ] Gmail OAuth (PKCE) + read/send mail tools
7. [ ] MS Graph OAuth (PKCE) + basic mail/calendar/OneDrive tools
8. [ ] Confirmation flow for write actions (send email, create event, on both providers)
9. [x] Wire everything together end-to-end — WhatsApp messages now reach Gemini and get replies. Done out of order (before 4–8) at explicit request; memory (M4) has since landed — see Status below.
10. [ ] Deploy to Oracle VM with systemd

## Status / Where We Left Off

- M1–M3 done and merged to `main` (each feature branch was merged locally with `git merge --no-ff` + `git push origin main` — no GitHub PRs were actually opened for M2/M3, just the branch + local merge).
- **M9 (wiring) done out of order, 2026-09-14**: WhatsApp messages now reach Gemini and get real replies. `src/whatsapp/index.js` extracts text, skips group chats (`@g.us`) and unsupported message types, calls `src/llm/respond.js`, and sends the reply back via `sock.sendMessage`. `respond.js` uses Gemini function calling (not built-in grounding — see deviation below): declares a `web_search` tool, and when Gemini calls it, runs a Tavily search and feeds results back for up to 3 follow-up turns before forcing a text-only final answer. Confirmed end-to-end over live WhatsApp messages.
- **M4 (short-term memory) done, 2026-09-18**: `src/memory/short-term.js` (better-sqlite3, `messages` table keyed by chat JID, path from `SHORT_TERM_DB_PATH`, `data/` is gitignored). `initShortTermMemory()` runs at startup in `src/index.js` and is fatal on failure. Each turn replays the last 20 messages to Gemini (`getHistory`) and afterwards stores the user text + final reply as one transaction (`saveExchange`); tool calls/search results are not stored, and rows are pruned to 200 per chat. `getReply` in `respond.js` now throws on failure instead of returning an apology string, so the WhatsApp handler can send the fallback without saving it as a real answer. Known gaps: two messages from the same chat arriving back-to-back are handled concurrently, so the second doesn't see the first's reply in its history; no age cutoff on history (a days-old exchange is still replayed).
- Local `.env` already has a real `GEMINI_API_KEY` (no-billing project, confirmed "Free tier" in AI Studio) and `TAVILY_API_KEY`, and `auth_info_baileys/` already holds a linked WhatsApp session — don't need to redo device pairing or key setup to keep building.
- `GEMINI_MODEL` is pinned to `gemini-2.5-flash` rather than the `gemini-flash-latest` alias — the alias was resolving to `gemini-3.8-flash`, which hit frequent `503 UNAVAILABLE` ("high demand") errors in testing, presumably from being a newer/lower-capacity release. Revisit the pin periodically.
- **Model pin is stale and probably not being applied (found 2026-09-18, not yet fixed)**: (1) a direct call with `GEMINI_MODEL=gemini-2.5-flash` returned `404 — no longer available to new users`, suggesting `gemini-3.6-flash`; the pin needs updating. (2) `MODEL` in `src/llm/generate.js` is read at import time, but `dotenv`'s `config()` in `src/index.js` runs after the hoisted ES imports, so the running app likely ignores `.env`'s `GEMINI_MODEL` and falls back to `gemini-flash-latest`. Fix both together (e.g. read the env var lazily inside `generateReply`) in its own small branch.
- Free tier RPM is low (hit a documented `generate_content_free_tier_requests` limit of 20/min during rapid manual testing) — fine for real personal-assistant usage (occasional messages), but don't rapid-fire test messages without expecting 429s.
- **Known deviation from Tech Stack**: `@whiskeysockets/baileys` in `package.json` points at a fork (`github:doryani-ai/Baileys#fix/companion-reg-refresh`), not the official npm package. Official releases (6.7.24 and all 7.0.0 RCs) can't complete QR pairing — WhatsApp added a `companion_reg_refresh` step to device linking (~July 2026) that no current release handles (see `WhiskeySockets/Baileys#2737`, unmerged fix in `#2765`). Check if that PR merged upstream before doing more WhatsApp-related work; switch back to the official package if so.
- **Known deviation from Tech Stack**: web search uses the **Tavily Search API** (called as a Gemini function-calling tool), not Gemini's built-in `googleSearch` grounding tool. Tested 2026-09-14: on a genuinely free-tier (no billing linked) Gemini API project, plain `generateContent` calls succeeded but every call with `tools: [{ googleSearch: {} }]` returned `429 RESOURCE_EXHAUSTED` — grounding appears to require billing enabled even when the base model doesn't. Re-verify against ai.google.dev's grounding docs before switching back; if grounding becomes free-tier-usable, `src/llm/respond.js` + `src/llm/webSearch.js` would need replacing with the grounding-tool approach again. (Brave Search API was tried first but turned out not to be free either — Tavily's free tier is what's actually wired up.)
- `dotenv.config()` is called with `{ quiet: true }` in `src/index.js` — the official `dotenv` package prints unrelated promotional "tips" to console on load by default, which was polluting the pino logs.

## Known Constraints / Gotchas to Respect in Code

- Baileys is an unofficial client → real ban risk. Avoid aggressive polling, respect rate limits, no spammy behavior.
- Gemini free tier limits change; don't hardcode assumptions about RPM/TPM without a comment noting they may need rechecking.
- Gmail API has daily quota limits on a free/testing OAuth client; don't assume unlimited calls, especially for polling-style features.
- Oracle Always Free ARM allocation is 2 OCPU / 12GB total as of June 2026; this project uses 1 OCPU / 6GB, leaving headroom.
- No paid services, ever. If a free-tier limit is a blocker, flag it and propose alternatives instead of assuming upgrade.
