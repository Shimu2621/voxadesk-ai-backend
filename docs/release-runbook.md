# VoxaDesk AI release runbook

1. Use Node 22, PostgreSQL, and Redis. Copy `.env.example` to `.env`; never commit it.
2. Run `npm ci`, `npm run db:generate`, and deploy migrations before application processes.
3. Seed only a non-production demo database with `npm run db:seed`.
4. Run type-check, lint, tests, dependency audit, and production builds in both repositories.
5. Run the API and worker separately and check live/ready health endpoints, database access, Redis, and failed jobs.
6. In mock mode, connect all providers and exercise FAQ, unknown, booking, duplicate, after-hours, and transfer/callback scenarios.
7. In live mode, configure every provider variable and use dedicated test phone, calendar, and billing resources.
8. Roll application code back if health gates fail. Change schema only through a reviewed compensating migration.
9. Rotate compromised credentials at the provider and secret store, restart affected processes, reconnect, and inspect audits.
10. Restore into a clean database from a verified backup, apply later migrations, then replay provider events using idempotency keys.
