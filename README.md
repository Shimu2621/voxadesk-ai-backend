# VoxaDesk AI Backend

This repository is the API and background worker. The Next.js application is
the sibling `voxadesk-ai-frontend` repository and defaults to
`http://localhost:3000`.

## Local portfolio demo

1. Copy `.env.example` to `.env` and fill it locally. Never commit that file.
2. Use PostgreSQL and Redis development instances.
3. Set `PROVIDER_MODE` to `mock` and provide a 32+ character
   `MOCK_WEBHOOK_SECRET`. `DATABASE_URL` and a 32+ character `AUTH_SECRET` are
   always required.
4. Run `npm install`, `npm run db:generate`, `npm run db:migrate`, and
   `npm run db:seed`.
5. In separate terminals, run `npm run dev` and `npm run worker`.
6. Start the sibling frontend as documented in its README.

Mock mode is intentionally a portfolio simulation. Email is kept in an
in-memory outbox, storage is in memory, knowledge extraction is fake, and live
inbound Twilio calling is not enabled. Use the seeded verified account for the
local demo. Do not seed a production database.

Private `.env*` files are ignored. Only the empty `.env.example` template
belongs in Git.

Express backend and BullMQ worker for VoxaDesk AI. This repository owns tenant data, authorization, agent configuration, provider tools/webhooks, conversations, appointments, usage, and billing state.

## Stack

- Node.js + Express + TypeScript
- Zod validation
- PostgreSQL + Prisma
- Redis + BullMQ
- Provider boundaries for ElevenLabs Agents, Twilio, Google Calendar, and Stripe

## Run locally

1. Copy `.env.example` to `.env` and replace the development secrets.
2. Run `docker compose up -d` for PostgreSQL and Redis.
3. Run `npm install`.
4. Run `npm run db:generate` and `npm run db:migrate`.
5. Run `npm run dev` and, separately, `npm run worker`.

The API listens on `http://localhost:4000` by default. Current auth headers are a development-only boundary and must be replaced by verified secure-cookie sessions before public deployment.

## Safety status

### Stripe CLI webhook testing

First connect the current organization from the browser: sign in as an OWNER,
open `/app/settings`, and click **STRIPE** under **Provider integrations**.
For real Stripe events (including CLI test events), the displayed provider mode
must be `live`. This calls the existing session- and CSRF-protected
`POST /api/v1/integrations/live/STRIPE` route. The organization comes from the
session; credentials stay on the backend. This links the server-configured Stripe
provider, not an individual merchant's Stripe Connect OAuth account. Mock mode
creates a simulated connection instead.

In browser Developer Tools → Network, select the successful connection request
and copy `data.id` from its JSON response; confirm `data.type` is `STRIPE` and
`data.status` is `connected`. For an existing connection, reload settings and
inspect the `GET /api/v1/integrations` response for that same record. No keys or
webhook secrets are needed in the browser. A disabled STRIPE button indicates an
already connected integration; missing connection buttons indicate a non-owner.

Stripe webhooks are available at `/api/v1/webhooks/stripe` and the existing
`/webhooks/stripe` alias. Both run before JSON parsing, session authentication,
and CSRF validation. Live signatures are checked against
`STRIPE_WEBHOOK_SECRET` using the original body and a five-minute tolerance.

The existing provider configuration requires `PROVIDER_MODE=live` for Stripe
events (including test-mode Stripe CLI events). `mock` expects the application's
mock envelope/signature; `disabled` returns 503. Live providers are configured
independently. Missing provider settings do not prevent application startup;
the affected provider's operations and connection routes report not configured.
Application settings such as `DATABASE_URL` and `AUTH_SECRET` remain required.

| Provider        | Required server configuration                                      |
| --------------- | ------------------------------------------------------------------ |
| Stripe          | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                       |
| ElevenLabs      | `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`                  |
| Twilio          | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`                          |
| Google Calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |

For Stripe CLI testing, use `PROVIDER_MODE=live`, a genuine Stripe **test** secret
key, and the webhook signing secret from the active CLI listener. No ElevenLabs,
Twilio, or Google configuration is required for Stripe. Checkout additionally
needs the selected plan's `STRIPE_GROWTH_PRICE_ID` or `STRIPE_AGENCY_PRICE_ID`;
these price settings are not needed to receive CLI webhook events. No fallback
secrets are supplied. Configuration presence checks cannot establish whether a
credential is authentic; provider requests and webhook signatures enforce that.

Use a connected STRIPE integration's ID to select the destination workspace:

```sh
stripe listen --forward-to "http://localhost:4000/api/v1/webhooks/stripe?integrationId=YOUR_CONNECTED_STRIPE_INTEGRATION_ID"
```

Set `STRIPE_WEBHOOK_SECRET` locally to the signing secret supplied by this CLI
listener, not a Dashboard endpoint's secret. Restart the backend after changing
environment settings, keep PostgreSQL and Redis running, then run:

```sh
stripe trigger checkout.session.completed
```

Successful ingestion returns 202 (200 for duplicates). Missing integration IDs
return 400; IDs without a connected STRIPE integration return 404. This verifies
webhook ingestion, not completion of a real subscription purchase.

Known worker limitation: the Stripe processor currently applies a subscription
schema to every Stripe event. A Checkout session's `complete` status is not a
valid subscription status, so a standard `checkout.session.completed` payload
can be accepted with 202 and subsequently fail processing. Confirm the persisted
event's `status` and `processedAt` separately; do not treat HTTP acceptance as
proof that subscription processing succeeded.

Verification failures log only a provider and error category. Private `.env`
files are excluded from the source secret scan; `.env.example` is scanned.

The application fails closed for calendar actions and provider webhooks until credentials, OAuth, signature verification, and idempotent processors are implemented. It never reports a booking as successful without a provider-confirmed action.
