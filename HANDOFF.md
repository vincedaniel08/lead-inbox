# Lead inbox — handoff

**Live:** LIVE_URL_HERE
- Public form: `/`
- Owner dashboard: `/admin.html`
- API: `/api/leads`

## Credentials (test values; rotate before real use)

| What | Value |
|---|---|
| Owner login (dashboard) | `owner@likeablelosers.test` / `Olu7wP2vfKU5` |
| `API_TOKEN` | `bQQ_tYIc2D_3QPU8Wbs8X-irW66ejW1w` |
| `WEBHOOK_URL` | `https://webhook.site/5b905039-3a91-4257-a477-3a910ee4db0c` |

## Stack

Node 20+ / Express 5, Postgres (Neon, free tier) in production, deployed on Vercel. Sorting uses Claude when `ANTHROPIC_API_KEY` is set and falls back to keyword rules. No build step and no frontend framework: just two static HTML pages.

## Run it locally

```bash
npm install
API_TOKEN=dev OWNER_EMAIL=me@example.com OWNER_PASSWORD=dev node server.js
```

Open http://localhost:3000. With no `DATABASE_URL` set, it uses an embedded Postgres (PGlite) stored in `./.data`, so you don't need Docker.

Contract test (runs against any deployment):

```bash
BASE_URL=http://localhost:3000 API_TOKEN=dev node test.js
```

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | prod | Postgres connection string. The table is created on first request. |
| `API_TOKEN` | yes | Bearer token for every route except `POST /api/leads`. If it's unset, all protected routes return 401. |
| `OWNER_EMAIL`, `OWNER_PASSWORD` | yes | Dashboard login. |
| `WEBHOOK_URL` | no | Gets `{"event":"lead.created","lead":{...}}` for every new lead. |
| `ANTHROPIC_API_KEY` | no | Turns on AI sorting. `ANTHROPIC_MODEL` overrides the model (default `claude-opus-5-5`; `claude-haiku-5-5` is cheaper and good enough for this). |
| `SESSION_SECRET` | no | Signs dashboard cookies. Defaults to `API_TOKEN`. |

## What works

- Public form with server-side validation. Bad input gets a 400 with `{"error": "..."}`. That includes invalid JSON, wrong types, oversized bodies and NUL bytes.
- Leads are stored in Postgres, so they survive a refresh, a restart and a redeploy.
- Every new lead gets a category and an urgency. AI is tried first (8s timeout); keyword rules take over on any failure or when there's no key.
- Webhook fires after the lead is saved. If it's down or slow (5s timeout), the error is logged and the lead still returns 201.
- Owner dashboard: login, newest first, filter by status and category, change status, add a note. It works at phone width.
- API matches the brief: 201/200/400/401/404, field names and order, `created_at` like `2026-11-07T09:30:00Z`.
- `test.js` checks the whole contract, including a lead still saving when the webhook is down and data surviving a restart. It passes locally. Live run: LIVE_TEST_RESULT.

## Calls I made where the brief was open

- **Text is stored exactly as typed.** Nothing is trimmed or escaped on the server. A name that is only spaces counts as empty. The dashboard renders text with `textContent`, so HTML can't inject.
- **Length = characters, not bytes.** An emoji counts as 1.
- **Email** must look like `x@y.z` (no spaces, max 254 characters). **Phone** is optional: digits, spaces and `+ ( ) - .` only, max 30 characters. `null` or a missing phone becomes `""`.
- **`service` is case-sensitive** (`cleaning` works, `Cleaning` doesn't).
- **List** returns the newest 500. An unknown `?status=` or `?category=` value returns 400 instead of an empty list, so typos are visible.
- **Ids that aren't numbers** (`/api/leads/abc`) return 404, the same as a missing id. Auth is checked first, so no token means 401 even for a missing id.
- **PATCH** with neither `status` nor `note` returns 400. The note max is 2000 characters. `note: ""` clears it.
- **Urgency rules:** emergencies and same-day requests are high. Complaints default to high, because an angry customer needs a fast callback. Explicit "no rush" is low. Everything else is normal.
- **Dashboard auth** uses a signed httpOnly cookie (SameSite=Strict, 12h). The API also accepts that cookie when no `Authorization` header is sent. With a header, the token must be right.

## What's missing / known limits

- No rate limiting or captcha on the public form or the login. Spam and brute-force protection would come next.
- One owner account from env vars. No users table, no password reset.
- No pagination beyond the newest 500.
- Webhooks aren't retried or signed. If `WEBHOOK_URL` is down, that event is lost (the lead is not).

## What I'd do next

1. Rate limit `POST /api/leads` and `/auth/login`, and add a honeypot field to the form.
2. Webhook outbox table with retries and an HMAC signature header.
3. Cursor pagination (`?before=<id>`) and search.
4. Let the owner fix a wrong category or urgency from the dashboard, and log those fixes to tune the sorting.
