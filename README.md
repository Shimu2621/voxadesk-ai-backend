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

The application fails closed for calendar actions and provider webhooks until credentials, OAuth, signature verification, and idempotent processors are implemented. It never reports a booking as successful without a provider-confirmed action.
