# VoxaDesk AI Backend

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

