# Lead inbox handoff

Live URL: LIVE_URL_HERE

- Form: `/`
- Dashboard: `/admin.html`
- API: `/api/leads`

## Logins

- Owner login: `owner@likeablelosers.test` / `Olu7wP2vfKU5`
- API_TOKEN: `bQQ_tYIc2D_3QPU8Wbs8X-irW66ejW1w`
- WEBHOOK_URL: `https://webhook.site/5b905039-3a91-4257-a477-3a910ee4db0c`

These are test values. Change them before real use.

## Stack

Node 20, Express 5, Postgres on Neon, hosted on Vercel. The form and dashboard are plain HTML pages with no build step.

## How to run it

```bash
npm install
API_TOKEN=dev OWNER_EMAIL=me@example.com OWNER_PASSWORD=dev node server.js
```

Then open http://localhost:3000. If `DATABASE_URL` is not set, it uses PGlite (Postgres in a local folder, `./.data`), so you don't need to install a database.

To test the API against any URL:

```bash
BASE_URL=http://localhost:3000 API_TOKEN=dev node test.js
```

## Environment variables

- `DATABASE_URL`: Postgres connection string. The table is created on the first request.
- `API_TOKEN`: needed for every route except `POST /api/leads`. If it's missing, those routes always return 401.
- `OWNER_EMAIL`, `OWNER_PASSWORD`: dashboard login.
- `WEBHOOK_URL`: optional. Gets a POST for every new lead.
- `ANTHROPIC_API_KEY`: optional. Turns on AI sorting. `ANTHROPIC_MODEL` changes the model (default `claude-opus-5-5`).
- `SESSION_SECRET`: optional. Signs the dashboard cookie. Uses `API_TOKEN` if not set.

## What works

- The form, with the same checks on the server. Bad input gets a 400 and an error message, including broken JSON and wrong types.
- Leads are stored in Postgres and survive restarts and redeploys.
- Each lead gets a category and urgency. It tries AI first (8 second timeout) and uses keyword rules if that fails or there is no key.
- The webhook is sent after the lead is saved. If the webhook URL is down, the lead still saves and returns 201.
- Dashboard: login, newest first, filter by status and category, change status, add a note. Works on a phone.
- `test.js` covers the API rules in the brief. It passes locally. Live run: LIVE_TEST_RESULT.

## Calls I made

- Text is saved exactly as typed. Nothing is trimmed. A name that is only spaces counts as empty.
- Length limits count characters, so an emoji counts as 1.
- Email must look like `name@domain.tld`. Phone is optional: digits, spaces and `+ ( ) - .`, max 30.
- `service` must be lowercase, as in the brief.
- The list returns the newest 500. An unknown `status` or `category` filter returns 400, not an empty list.
- An id that isn't a number returns 404. Auth is checked first, so no token gives 401 even for a bad id.
- PATCH with neither `status` nor `note` returns 400. Notes max out at 2000 characters.
- Complaints are high urgency by default. "No rush" style messages are low.
- The dashboard logs in with a signed cookie that lasts 12 hours. The API accepts that cookie when no Authorization header is sent.

## Not done

- No rate limit or captcha on the form or login.
- One owner account, set by env vars.
- No paging past 500 leads.
- Webhooks aren't retried. If the webhook fails, that event is lost, but the lead is kept.

## Next steps

1. Rate limit the form and login, and add a honeypot field.
2. Retry failed webhooks and sign them.
3. Paging and search in the dashboard.
4. Let the owner correct a lead's category or urgency.
