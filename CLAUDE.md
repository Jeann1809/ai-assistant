# WhatsApp Personal Assistant — Project Guide

Personal project for a CS student at Texas Tech. Solo-maintained, built incrementally, pushed to GitHub commit by commit. Optimize for simplicity and things I can defend in interviews, not cleverness.

## Tech Stack

- **Backend**: Node.js
- **WhatsApp**: `@whiskeysockets/baileys` (unofficial client, no Chromium needed, lower RAM than whatsapp-web.js)
- **LLM**: Gemini API, current Flash model, function calling / tool use
- **Web search**: Gemini's built-in Google Search grounding (not Custom Search JSON API)
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

1. Project skeleton + config + `.env.example`
2. Baileys connection (QR auth, reconnect logic, message listener)
3. Gemini client wrapper (function calling, error/rate-limit handling)
4. SQLite short-term memory
5. sqlite-vec long-term memory
6. Gmail OAuth (PKCE) + read/send mail tools
7. MS Graph OAuth (PKCE) + basic mail/calendar/OneDrive tools
8. Confirmation flow for write actions (send email, create event, on both providers)
9. Wire everything together end-to-end
10. Deploy to Oracle VM with systemd

## Known Constraints / Gotchas to Respect in Code

- Baileys is an unofficial client → real ban risk. Avoid aggressive polling, respect rate limits, no spammy behavior.
- Gemini free tier limits change; don't hardcode assumptions about RPM/TPM without a comment noting they may need rechecking.
- Gmail API has daily quota limits on a free/testing OAuth client; don't assume unlimited calls, especially for polling-style features.
- Oracle Always Free ARM allocation is 2 OCPU / 12GB total as of June 2026; this project uses 1 OCPU / 6GB, leaving headroom.
- No paid services, ever. If a free-tier limit is a blocker, flag it and propose alternatives instead of assuming upgrade.
