# Operations

## Memory

Two settings matter: `DUCKDB_MEMORY_LIMIT`, which DuckDB keeps its buffers, sorts and joins under, and the container limit (`STRAVA_MCP_MEMORY`, 1 GB by default). The process needs roughly 300 MB on top of DuckDB's limit for Node itself, JSON parsing (DuckDB parses a vector of payloads outside its limit) and allocator slack.

Measured in the image on a mirror of 1,859 activities with full streams (310 MB of stream payloads, 700 MB file), `DUCKDB_MEMORY_LIMIT=384MB`, peak resident memory of one operation per process:

| Operation | Peak RSS |
|---|---|
| Open the mirror | 146 MB |
| Read one activity's streams (the tool path) | 201 MB |
| Project one activity's streams into points (landing) | 287 MB |
| Planner (every gap in the mirror) | 186 MB |
| Drift check (`strava_sync_status`, hourly) | 449 MB |
| Publish the snapshot | 126 MB |

The same operations at 512 MB are within 50 MB of these, because what grows with the limit is DuckDB's cache. Version 3 needed 2.1 GB for the drift check and 1.1 GB for a snapshot; the [data page](data/index.md#the-raw-store) explains what changed.

Rules of thumb:

- **1 GB** for the container with the default 384 MB fits a few thousand activities. The limits above are per operation and do not add up: the server runs one DuckDB statement at a time.
- **Bigger accounts** mostly grow the chunk and point tables, which scans read in bounded pieces; the drift check parses a fixed sample. Watch `docker stats` and raise `DUCKDB_MEMORY_LIMIT` only when `strava_query` reports out-of-memory for a query you need; raise the container limit by the same amount.
- **Heavy SQL** through `strava_query` (sorting all stream points, wide joins) runs under DuckDB's limit and spills to the data volume's `duckdb-tmp/` when it must; a query that cannot fit fails with an out-of-memory error rather than taking the server down.
- `DUCKDB_THREADS=2` is enough; the workload is small queries, and fewer threads mean fewer concurrent buffers.

`scripts/bench-memory.ts` reproduces the table on a copy of your mirror; [CONTRIBUTING](https://github.com/justmytwospence/strava-mcp/blob/main/CONTRIBUTING.md) explains how.

## Disk

The mirror file grows with the account and never shrinks (DuckDB reuses freed blocks but does not truncate). The figures above come from 1,859 activities in a 700 MB file, of which half is free space left by the 4.0 migration; the snapshot is the same size. Count on roughly 250 MB per 1,000 activities with streams, times two for the snapshot, plus whatever the backup profile keeps.

## Upgrades

```sh
docker compose pull
docker compose up -d
```

Schema changes are migrations applied at startup; the server logs them and the health check allows three minutes before it starts counting failures. The image tags follow semantic versions: `4` tracks the latest 4.x, `4.1` the latest patch of 4.1, `4.1.0` never moves.

### From 3.x to 4.0

The first start converts the raw store: payloads over 4,000 bytes move into `raw_blob` and the point tables are rebuilt without their primary keys. It is one-off, resumable if interrupted, and takes about a minute for 2,000 activities. It must read the old layout, which is exactly what needed so much memory: **allow the container 2 GB for that start** (`STRAVA_MCP_MEMORY=2g`, then back to `1g`), or on a large mirror 2.5 times the size of `raw_payload`. The migration of the 1,859-activity mirror above peaked at 1.9 GB.

Also in 4.0: `MCP_BEARER_TOKEN` is required by the Compose file (set one), `STRAVA_REFRESH_TOKEN` is optional once a token file exists, the Compose file moved from a bind mount to the `strava-data` volume (copy `strava.duckdb`, `tokens.json` and `snapshot/` into it, or restore from a backup), and the DuckDB memory default is 384 MB. The [changelog](https://github.com/justmytwospence/strava-mcp/blob/main/CHANGELOG.md) has the full list.

## Health and logs

- `GET /health` answers `{"status":"ok","name":"strava-mcp-server","version":"..."}` once the mirror is open; the image's health check uses it.
- `docker compose logs -f strava-mcp` shows startup, migrations, each failed job, webhook registration, and snapshot failures. Routine jobs are not logged; `sync_log` in the mirror has them, and `strava_sync_status` summarizes.
- `strava_sync_status` is the first thing to ask when something looks stale: it shows the queue, the last run of each periodic task, the last errors, the rate-limit usage and the webhook state.

## Troubleshooting

**The server exits with status 70 and restarts.** DuckDB declared the database invalid after a failed commit or rollback (it logs `the DuckDB database is no longer usable`). Exiting is deliberate: every later statement would fail, and a restart recovers from the write-ahead log. If it repeats, check the disk (space, a read-only volume) and the memory limit; an out-of-memory during a checkpoint is the usual cause.

**`Cannot refresh the Strava token`** at startup. No refresh token anywhere: run `docker compose run --rm -p 8765:8765 strava-mcp auth`. After the athlete revokes the application, the same error appears on the next refresh; authorize again.

**`401` from `/mcp`.** The client sends no bearer, or the wrong one. With the oauth profile, the gateway answers `401` with a `WWW-Authenticate` pointer by design; a client that does not support MCP authorization needs the bearer and the server's own port instead.

**`Invalid Host header`.** `MCP_ALLOWED_HOSTS` is set and does not include the hostname the client used.

**Webhook `registration failed`.** Strava could not validate the callback: the URL is not public, has no valid certificate, or the path is proxied with a different prefix. The server retries with backoff and polls every 15 minutes meanwhile.

**Rate limited.** `strava_sync_status` shows `blocked_until` and the usage of both pools. The backfill slows down by design; tools keep a reserved share. If you also use the application elsewhere, the shares are computed from the headers Strava returns, so the other use is accounted for.

**Grafana shows no data.** The datasource reads the snapshot, which exists only after the first publish (an hour after the first sync, six during a backfill); until then the file is missing. Check `docker compose logs grafana` for the plugin loading (`motherduck-duckdb-datasource`).

**The migration was interrupted.** Start again; it resumes from its last committed vector. A mirror left with `raw_payload_v2` is in the middle of the migration and is handled on the next start.

## Stopping and removing

`docker compose down` stops everything and keeps the volumes; `docker compose down -v` deletes the mirror, the snapshot and the tokens. Revoke the application at [strava.com/settings/apps](https://www.strava.com/settings/apps) to end its access.
