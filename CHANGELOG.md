# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- Licensed under the [PolyForm Noncommercial License 1.0.0](https://github.com/justmytwospence/strava-mcp/blob/main/LICENSE.md) instead of MIT: free for personal use, research, education and noncommercial organizations; commercial use requires a separate license. Versions released before 2026-10-27 (up to 4.4.1) remain available under MIT.

## [4.4.1] - 2026-10-26

### Fixed

- Enforce agent SQL with `BEGIN TRANSACTION READ ONLY` before extraction/preparation, serialized per-mirror access and reliable rollback/discard on cleanup failures. This blocks `EXPLAIN ANALYZE` mutations that statement-type checks alone accepted; actual pinned Node-driver tests use only synthetic in-memory/file sentinels.
- Missing rate headers no longer mark paths quota-free. Every HTTP attempt reserves known overall/read pools, with conservative local estimates separate from header observations, independent persisted pool restoration, existing background reserves and `Retry-After` cooldowns.
- Validate IDs, date windows, prompt lookbacks and upload base64 at runtime. Keep downsampled streams within `max_points`; disclose partial coverage and bounded/truncated results.

### Added

- Server instructions plus a zero-call static usage guide listing all URI templates and prompt names with bounded examples/costs. Local schema, coverage/status and budget resources support clients that do not surface initialize instructions or template discovery.
- Compatible structured results alongside existing text, with output schemas for stable SQL/schema shapes. Existing resources and prompts retain source/fetch/stale provenance; resource bodies are bounded without corrupting JSON/XML.
- Offline MCP wire-contract, synthetic SQL safety, fake-transport budget/retry and concurrent admission regressions. Releases now require successful lint/build/typecheck/tests/generated-reference checks before publication.

### Changed

- Prompt retrieval uses stored data only: no API calls, refreshes or queued sync. Refresh missing context intentionally with tools after checking budget. Analysis prompts disclose incomplete history, the 200-item cap and text truncation.
- Update/star tools advertise destructive replacement/removal accurately; hints do not enforce consent. Tool descriptions and status explain API costs, pagination, unknown quotas and safe retries.

## [4.3.0] - 2026-10-25

### Added

- `STRAVA_ROUTES_INTERVAL_MINUTES`: how often the route list (and each route's starred flag) is refreshed, default 60, minimum 5. Lower it when something consumes the starred flag promptly, such as garmin-mcp's course cleanup.
- `GET /export/sync`, the live export for other services, documented as a stable contract in the new Export API reference. `/export/garmin-sync` stays as an alias.
- The npm package `@justmytwospence/strava-mcp` (bins `strava-mcp-server` and `strava-mcp-auth`), published with provenance by the release workflow, which now also creates the GitHub Release from the changelog.
- `LICENSE` (MIT), a pull request template, Biome linting and a type check over the tests and scripts in CI.
- Documentation: a product home page, FAQ, troubleshooting, first-sync guide, client setup for Claude Code, Claude Desktop, claude.ai, Cursor, VS Code, Codex, ChatGPT, Gemini CLI and pi, and a garmin-mcp integration page.

### Changed

- The route list is refreshed hourly by default again (4.2 polled every 15 minutes for every user, about a tenth of the default daily read budget); see `STRAVA_ROUTES_INTERVAL_MINUTES`.
- Compose passes the whole `.env` to the server through `env_file`, so every documented variable applies without being listed in `compose.yaml`; an empty variable counts as unset.
- Grafana and the notebook are published on `127.0.0.1` only (`GRAFANA_BIND`, `MARIMO_BIND` to change), since one has a default password and the other no login.
- `OIDC_JWKS_URL` is required for the `oauth` profile; its former default was Authelia's path.
- The server defaults `STRAVA_TOKEN_FILE` to `./state/tokens.json` outside the image, the same file `strava-mcp-auth` writes, so an npx run finds its tokens without configuration.
- `athlete_id` on `strava_list_athlete_routes` and `strava_get_athlete_stats`, and `include_all_efforts` on `strava_get_activity`, are optional; they were always ignored.
- Node 22 or later is required (20 is end-of-life).

### Fixed

- `strava_get_upload` and `strava_create_upload` could wait until midnight UTC after a daily rate limit; they now use the same 20-second wait cap as every other tool and answer with an error instead.
- The prompts and the segment GPX export format elevation and weight in the athlete's units (`STRAVA_UNITS`), and the activity analysis shows mile splits for imperial athletes; they hard-coded metres and kilograms.
- Dates in the prompts are rendered in UTC, so `start_date_local` is no longer shifted by the server's time zone.
- The export's route start point is decoded with `@mapbox/polyline`; a polyline that does not decode to a point on Earth gives `null`.
- Documentation: the snapshot is first published at startup, not within an hour of the first sync; the freshness and priority tables were incomplete; uploads are not stored; the rate-limit figures and the api-v3 date cite Strava's pages.

## [4.2.0] - 2026-10-25

### Added

- `GET /export/garmin-sync?since=`, served to the snapshot token: starred routes with their start point and the activities since a time, read live from the mirror, for garmin-mcp's Strava sync (no waiting for the hourly snapshot).

### Changed

- The route list is refreshed every 15 minutes, so an unstarred route reaches consumers within about a quarter of an hour.

## [4.1.0] - 2026-10-25

### Changed

- The route list is refreshed hourly instead of daily, so starring or unstarring a route (which Strava sends no webhook for) reaches the snapshot within about two hours.

## [4.0.0] - 2026-10-24

A release for strangers: a self-contained Compose stack, a documentation site, an authorization command, and a raw store that keeps memory bounded on real accounts.

### Breaking changes

- **Storage.** Payload bodies over 4,000 bytes are now stored as chunks in the new `raw_blob` table and `raw_payload.body` is `NULL` for them; `raw_current` reassembles the body and is the view to query for raw JSON. The point tables (`activity_stream_point`, `segment_stream_point`, `segment_effort_stream_point`, `route_point`) and `raw_blob` have no primary key. Both changes are migrations applied at the first start; the first needs memory proportional to the old layout (about 2 GB for 2,000 activities with streams) and is resumable. See the operations guide.
- **Compose.** `MCP_BEARER_TOKEN` is required (the endpoint was open by default). The container has a 1 GB memory limit by default (`STRAVA_MCP_MEMORY`), and the image tag is `4`. If you kept the mirror in a bind mount of your own, either keep that mount in a Compose override or move `strava.duckdb`, `tokens.json` and `snapshot/` into the `strava-data` volume.
- **Snapshots** are a byte copy of the checkpointed mirror file instead of a `COPY FROM DATABASE`, so they are the same size as the mirror (including free space) rather than compacted.
- **Defaults.** `DUCKDB_MEMORY_LIMIT` in the image is 384 MB (was 256 MB); the health check's start period is three minutes.
- **SQL.** File access from `strava_query` is fully disabled (the snapshot directory was reachable before).

### Added

- `strava-mcp-auth` (also `strava-mcp-server auth`, and `docker compose run --rm -p 8765:8765 strava-mcp auth`): the Strava authorization flow for your own API application, writing the token file; `STRAVA_REFRESH_TOKEN` is optional once the file exists.
- Compose profiles: `oauth` (agentgateway as an OAuth 2.1 resource server for any OIDC provider), `grafana` (DuckDB datasource and a provisioned dashboard over the snapshot), `notebooks` (a marimo notebook with a map of any activity), `backup` (scheduled archives of the tokens and the snapshot).
- Documentation site (MkDocs Material) with generated tool and schema references, Mermaid ERDs, provider notes for Authelia, Authentik, Keycloak and Pocket ID, and webhook recipes for reverse proxies, Cloudflare Tunnel and Tailscale Funnel.
- `scripts/bench-memory.ts`, the memory benchmark behind the sizing guide.
- CONTRIBUTING, SECURITY, issue templates, a docs workflow publishing to GitHub Pages, an image build in CI.

### Fixed

- Memory: reading one row of `raw_payload` materialized every body in its 2,048-row DuckDB vector once small and multi-megabyte payloads shared a vector; the drift check peaked at 2.1 GB, a single stream read at 630 MB, a snapshot at 1.1 GB, regardless of `DUCKDB_MEMORY_LIMIT`. With chunked bodies, no keys on the point tables (an ART index over millions of rows was rewritten at every checkpoint) and file-copy snapshots, the same operations peak at 449 MB, 201 MB and 126 MB with a 384 MB limit.
- The server exits with status 70 when DuckDB invalidates the database after a failed commit or rollback, so the container runtime restarts it, instead of answering every later request with an error.
- The activity list no longer joins every detail body to serve a page.

## [3.1.1] - 2026-10-24

- Drift check samples the newest payloads, avoids join buffering, and is cached for an hour.

## [3.1.0] - 2026-10-24

- Strava push subscription (`STRAVA_WEBHOOK_URL`): new, edited and deleted activities arrive without polling the activity list.

## [3.0.3] - 2026-10-23

- Projections scope both sides of the raw join, so each job reads only its own payloads.

## [3.0.2] - 2026-10-23

- Activity streams are projected in one JSON pass, so long activities fit the memory limit.

## [3.0.1] - 2026-10-22

- Stream fields are checked for drift without extracting the data arrays.

## [3.0.0] - 2026-10-22

- All Strava data is mirrored in DuckDB and the tools are served from it: raw store with edit history, typed tables with comments, the sync engine with rate-limit shares and priorities, cache-first tools with provenance, the read-only snapshot and `GET /snapshot.duckdb`, `strava_query`, `strava_schema`, `strava_sync_status`.
- Optional bearer token on the MCP endpoint (`MCP_BEARER_TOKEN`).

## [2.0.1] - 2026-10-04

- Report healthy within seconds of starting.

## [2.0.0] - 2026-10-04

- MCP SDK v2, Streamable HTTP transport, Docker image and Compose file, rotated tokens persisted to `STRAVA_TOKEN_FILE`, the athlete's unit preference, reference resources.

## [1.x] - 2026-03

- Initial server over the Strava API: activities, athletes, segments, routes with GPX and TCX export, streams, clubs, gear, uploads; resources and prompts.

[Unreleased]: https://github.com/justmytwospence/strava-mcp/compare/v4.3.0...HEAD
[4.3.0]: https://github.com/justmytwospence/strava-mcp/compare/v4.2.0...v4.3.0
[4.2.0]: https://github.com/justmytwospence/strava-mcp/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/justmytwospence/strava-mcp/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/justmytwospence/strava-mcp/compare/v3.1.1...v4.0.0
[3.1.1]: https://github.com/justmytwospence/strava-mcp/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.3...v3.1.0
[3.0.3]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/justmytwospence/strava-mcp/compare/v2.0.1...v3.0.0
[2.0.1]: https://github.com/justmytwospence/strava-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/justmytwospence/strava-mcp/releases/tag/v2.0.0
