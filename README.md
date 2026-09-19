# Issue Pilot Cloud Service

Cloudflare Worker + D1 service for receiving GitHub App issue events and handing approved jobs to a local desktop agent. Source code, Codex, git, commits and pull requests remain on the desktop machine.

## Setup

1. Install dependencies: `npm install`.
2. Create a D1 database: `npx wrangler d1 create issue-pilot`; copy its returned `database_id` into `wrangler.toml`.
3. Create `.dev.vars` from `.dev.vars.example`, then set real values. Keep it untracked.
4. Create a GitHub App with a webhook URL of `https://<worker-domain>/github/webhook`, **Metadata: read**, **Issues: read**, and subscriptions to **Issues**, **Installation**, and **Installation repositories**. Install it only for your intended repositories.
5. Put the numeric GitHub account ID in `ALLOWED_GITHUB_ACCOUNT_IDS`, not the login name. Deploy secrets with `npx wrangler secret put WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `DESKTOP_API_TOKEN`.
6. Apply the production schema: `npx wrangler d1 migrations apply issue-pilot --remote`; then deploy: `npm run deploy`.

For local work run `npx wrangler d1 migrations apply issue-pilot --local` and `npm run dev`.

## Desktop API

Every `/v1` request uses `Authorization: Bearer <DESKTOP_API_TOKEN>`. Fetch the machine-readable API skeleton from `GET /openapi.json`.

Typical desktop flow:

1. `POST /v1/github/sync` finds repositories available to the installed GitHub App.
2. Enable a repository with `PATCH /v1/repositories/:id` and `{ "active": true }`. The scheduled sync imports its open issues.
3. Poll `GET /v1/issues?state=open` every 10 seconds. Approve a reviewed issue with its returned `version` and a unique `Idempotency-Key`.
4. Poll queued jobs, atomically claim with `client_id` and a persistent UUID `claim_id`, then heartbeat every 30 seconds.
5. Report phases and eventual `succeeded`/`failed` status, including a summary, commit SHA and PR URL when present.

Jobs with no heartbeat for five minutes become `interrupted`; they never auto-retry. Use `/v1/jobs/:id/retry` after local inspection.

## Checks

Run `npm run typecheck` and `npm test`. The test setup uses the Cloudflare Workers test pool and local D1 migration configuration; add API integration tests beside `test/security.test.ts` as the desktop client is built.

## Operational notes

The Worker logs identifiers and error codes only. Do not log issue bodies, tokens, private keys or full agent logs. The cron performs bounded repository syncs each minute, starts a normal sync at least every 15 minutes, and marks stale running jobs interrupted.
