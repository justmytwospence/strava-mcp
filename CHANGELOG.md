# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- The route list is refreshed hourly instead of daily, so starring or unstarring a route (which Strava sends no webhook for) reaches the snapshot within about two hours.

## [4.0.0] - Unreleased

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

[4.0.0]: https://github.com/justmytwospence/strava-mcp/compare/v3.1.1...HEAD
[3.1.1]: https://github.com/justmytwospence/strava-mcp/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.3...v3.1.0
[3.0.3]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/justmytwospence/strava-mcp/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/justmytwospence/strava-mcp/compare/v2.0.1...v3.0.0
[2.0.1]: https://github.com/justmytwospence/strava-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/justmytwospence/strava-mcp/releases/tag/v2.0.0
