# Troubleshooting

`strava_sync_status` is the first thing to ask when something looks wrong: it shows the queue, the last run of each periodic task, the last errors, the rate-limit usage of both pools and the webhook state. `docker compose logs -f strava-mcp` shows startup, migrations, failed jobs, webhook registration and snapshot failures; routine jobs are only in the `sync_log` table.

## Authentication

**`No Strava tokens` at startup.** The token file (`/data/tokens.json` in the image, `./state/tokens.json` otherwise) has no refresh token and `STRAVA_REFRESH_TOKEN` is unset. Run the authorization once: `docker compose run --rm -p 8765:8765 strava-mcp auth`, or `strava-mcp-auth` with the npm package. [Authentication](authentication.md#the-servers-access-to-strava) covers the headless case.

**`Cannot refresh the Strava token`, or tools answer `Authentication failed (401)`.** Strava refused the refresh token. The usual cause is that the application was revoked at [strava.com/settings/apps](https://www.strava.com/settings/apps), or that the token file was restored from an old backup after a rotation (Strava may rotate the refresh token on any refresh, and only the newest one works). Authorize again with the same command; the server picks up the new file on its next refresh, or restart it.

**`Forbidden (403)` from one tool.** The token lacks a scope: `activity:read_all` for private activities, `activity:write` for creating or updating. Authorize again and leave every box ticked. The token file's `scope` field shows what was granted.

**The authorization page never loads.** The browser must reach port 8765 on the machine running the command. Forward it (`ssh -L 8765:localhost:8765 your-server`) and open the URL on your laptop, or let the page fail and paste the URL from the address bar into the waiting command (it contains the code). `--no-listen` skips the listener.

## Rate limits

**Rate limited.** `strava_sync_status` shows `rate_limits` with the usage and limit of both pools (overall and non-upload reads, 15-minute and daily) and `blocked_until` after a 429. The backfill slows down by design as a window fills; tools keep a reserved share and fall back to the stored copy, marked stale, when they would have to wait more than 20 seconds. If you also use the same API application elsewhere, that use is counted too, since the figures come from Strava's headers.

**The daily budget is spent before noon.** Something is spending reads faster than the backfill alone would. Check `outcomes_last_24h` and `queue` in `strava_sync_status`: a job that fails and retries, a tool called in a loop by a client, or another application sharing the credentials. The free rate-limit upgrade in the [API settings](https://www.strava.com/settings/api) doubles the read limits; `STRAVA_ROUTES_INTERVAL_MINUTES` set low costs one or two reads per interval.

**Everything waits until midnight.** A daily limit was reached (`blocked_until` shows the next midnight UTC). Nothing can be done until the window resets; tools keep answering from the mirror.

## Webhook

**`registration failed` in the logs.** Strava could not validate the callback: the URL is not reachable from the internet, has no valid certificate, or the path arrives at the server with a different prefix (a reverse proxy that strips or adds one). Test it yourself: `curl -i 'https://strava.example.com/webhook/<secret>?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y'` must reach the server and answer `403` with `verify token mismatch` (the token is wrong on purpose; a `404` or a proxy page means the path does not arrive). The server retries with backoff and keeps polling every 15 minutes meanwhile. [How sync works](sync.md#webhook) has recipes for reverse proxies and tunnels.

**Registered, but events never arrive.** `strava_sync_status` shows `webhook.state: active` and `events_24h: 0` after an upload. Strava sends events only for athletes who authorized the application. Check that `MCP_ALLOWED_HOSTS`, if set, includes the webhook's hostname (otherwise Strava's POST is answered with `Invalid Host header` and the event is lost), and that nothing in front of the server requires authentication on the webhook path. `docker compose logs strava-mcp | grep webhook` shows what arrived.

**`Invalid Host header`.** `MCP_ALLOWED_HOSTS` is set and does not include the hostname the client (or Strava) used.

## Snapshot

**Grafana or the notebook report that the snapshot file is missing.** The first snapshot is published when the server starts (nearly empty on a fresh install), then at most hourly while the sync is idle and every six hours during a backfill, and only when the mirror changed. If the file is missing well after a start, the logs show `snapshot: publish failed`: the snapshot directory is not writable, or the disk is full. The publisher also skips a tick while a `strava_query` has a transaction open; it tries again a minute later.

**The snapshot is older than expected.** During a backfill the interval is six hours, to keep the copy's I/O out of the sync's way. Restarting the server publishes a fresh one.

**The snapshot is empty or small.** On the very first start the mirror holds little yet; the next publish, an hour or six later, has the first listing and details. Check `coverage` in `strava_sync_status`.

## Memory and the database

**The container is OOM-killed, or `strava_query` answers out of memory.** DuckDB keeps its own buffers under `DUCKDB_MEMORY_LIMIT` (384 MB in the image) and the process needs roughly 300 MB on top. A query that sorts or joins millions of stream points may exceed the limit and fail with an out-of-memory error rather than take the server down; raise `DUCKDB_MEMORY_LIMIT` and `STRAVA_MCP_MEMORY` by the same amount if you need such queries. [Operations](operations.md#memory) has the measurements.

**The server exits with status 70 and restarts.** DuckDB declared the database invalid after a failed commit or rollback (the log says `the DuckDB database is no longer usable`). Exiting is deliberate: every later statement would fail, and a restart recovers from the write-ahead log. If it repeats, check the disk (space, a read-only volume) and the memory limit; an out-of-memory during a checkpoint is the usual cause.

**The 3.x to 4.0 migration was interrupted.** Start again; it resumes from its last committed vector. A mirror left with a `raw_payload_v2` table is in the middle of the migration and is handled on the next start. It needs about 2 GB for the container during that one start ([Operations](operations.md#from-3x-to-40)).

## Data

**`unmapped_fields` in `strava_sync_status` lists keys.** Strava returned fields no typed column maps yet. They are kept in the raw JSON (`raw_current`) and lost nowhere; `body->>'field'` reads them in SQL. Adding a column is a small change ([CONTRIBUTING](https://github.com/justmytwospence/strava-mcp/blob/main/CONTRIBUTING.md#adding-a-column)); an issue with the key names is welcome.

**An activity is missing.** Check whether it is in the mirror at all: `SELECT id, name, deleted_at FROM activity WHERE name ILIKE '%...%'`. If it has `deleted_at`, Strava answered 404 for it at some point (deleted, or made unavailable); if it is absent, the listing has not reached it yet (`coverage.oldest` in `strava_sync_status` shows how far back the mirror goes).

**A tool answers `Not found on Strava (as of ...)`.** The mirror recorded a 404 for that object and does not ask again; this covers deleted activities and manual activities without streams. If the object exists again, the next listing (or a webhook event) clears the record.
