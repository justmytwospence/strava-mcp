# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" button on the repository's Security tab, or by email to the maintainer listed on the GitHub profile, rather than in a public issue. Include what you found, how to reproduce it, and which version. You will get an acknowledgement within a few days; fixes are released as patch versions and noted in the changelog.

## What the server holds and exposes

- **Your Strava credentials.** The client secret is in the environment; the OAuth token pair is in `tokens.json` in the data volume (mode 0600). Anyone with either and the client id can read, and with the write scope modify, your Strava data. Back the token file up like a password.
- **Your training data.** The mirror and its snapshot hold everything Strava returns for the account, including GPS tracks, heart rate and private activities. Treat the data volume and backups accordingly.
- **`/mcp`** is protected by `MCP_BEARER_TOKEN` (required by the Compose file) or by the OAuth gateway. Without either it is open to anyone who can reach the port.
- **`SNAPSHOT_TOKEN`** unlocks two read-only endpoints, served only when it is set and only to that token: `/snapshot.duckdb`, the whole mirror as a file (every activity, GPS track and private detail), and `/export/sync` (alias `/export/garmin-sync`), a small live JSON export of the starred routes and recent activity names, times and ids, for services such as garmin-mcp. Treat the token as access to all of your training data, and give it only to readers that need it; it does not open `/mcp`.
- **Grafana and the notebook** (optional profiles) have full read access to the snapshot and weak or no authentication of their own, so Compose publishes them on the loopback interface only; expose them through something that authenticates.
- **The whole `.env`** is passed to the server container through `env_file`, profile secrets included.
- **The webhook path** is public by design and protected by its secret segment; an event only queues a re-fetch from Strava and is never stored as data.
- **SQL from the model.** `strava_query` accepts one read-only statement on its own connection, with file and network access disabled at the DuckDB level, so a query cannot read the token file or reach the network; a 30-second interrupt and DuckDB's memory limit bound it.
- **Nothing leaves the host** except requests to Strava's API and, with the oauth profile, JWKS fetches from your identity provider. There is no telemetry.

## Hardening

- Put a TLS reverse proxy in front of anything exposed beyond the host, set `MCP_ALLOWED_HOSTS` to the hostnames you use, and keep port 8000 unpublished when the oauth gateway is in front (route the webhook path, and `/export/` or `/snapshot.duckdb` if other services need them, to the server directly).
- Give the server its own Strava API application; revoking it at strava.com/settings/apps ends its access.
- Keep the image updated: `docker compose pull && docker compose up -d`.
