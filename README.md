# Admiral

Personal, single-user automation for scheduled Moodle / BigBlueButton classes. A
Playwright worker covers a class in listen-only mode, watches the participant
list, and hands off when the user joins. A Fastify API and lightweight PWA
provide status, day overrides, standdown, and manual join/leave. The worker
stores control state, events, and email outbox in SQLite.

## Local checks

`npm ci && npm test` runs TypeScript checking and the unit suite. Copy
`.env.example` to `.env` and set your own credentials and `SCHEDULE_B64`. Do
not commit secrets or schedule data. The worker/API use `npm run worker:start`
and `npm run api:start`; `docker compose up -d` runs the full stack.

## VPS deployment

CI tests both images and publishes SHA tags from `main`. To deploy, copy
`docker-compose.yml.deploy` to the VPS, set `ADMIRAL_TAG=sha-<full commit sha>`
in a separate shell environment or Compose `.env` (NOT the worker's secrets),
run `docker compose pull worker api`, then `docker compose up -d` and check
`https://<domain>/health`. Keep the previous tag so you can roll back by
repeating the same steps with that tag. The SQLite volume is not removed.
Deploy outside class hours: replacing the worker closes its browser session.
The API and worker have independent networks and healthchecks; Caddy routes to
`api:8080`. The public `/health` checks the worker too; `/livez` checks only the
API. Configure UptimeRobot to monitor the HTTPS `/health` response with a
keyword check for `"ok":true` and enable downtime AND recovery email alerts.

Back up the database regularly: use SQLite's online backup API
(`node:sqlite`'s `backup()`), then copy the result off the VPS and verify it
opens. **Do not**
copy the live `.db` file alone while WAL mode is in use. Keep backups separate
from the Docker volume. Monitor VPS disk free space (`df -h /`) and prune only
unused Docker images when space runs low; do not prune volumes.

## Phone UX and alerts

Opening the dashboard does **not** suppress auto-join. Use the explicit
“I'm in class” control to pause auto-join for 30 minutes; renew or cancel it
from the dashboard. Duplicate-name detection in the BBB room still hands off.
Routine milestones are kept in history rather than emailed (default
`EMAIL_QUIET_MODE=true`). The 16:00 IST wrap-up summarizes today's
override-applied schedule and coverage; actionable alerts and recovery notices
arrive separately. Coverage estimates are **not** proof of attendance.
The dashboard caches its last status for poor connectivity; offline controls
are disabled and the cached status is explicitly marked stale.

Room sweeps keep the existing defaults: a 5-minute post-join grace and 5-minute
low-headcount confirmation, with retries every 15 minutes. `SCHEDULE_B64`
remains the schedule source; remote schedule URLs are optional.
