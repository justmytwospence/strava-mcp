# Configuration

Everything is an environment variable. With Compose they come from `.env` (copy `.env.example`, which lists them all with the same descriptions); only the three marked required need a value. Running the image or the npm package directly, set them in the environment.

## Strava

| Variable | Default | Meaning |
|---|---|---|
| `STRAVA_CLIENT_ID` | required | Your Strava API application ([settings/api](https://www.strava.com/settings/api)). |
| `STRAVA_CLIENT_SECRET` | required | Its client secret. |
| `STRAVA_TOKEN_FILE` | `/data/tokens.json` in the image, unset otherwise | Where the OAuth token pair lives. Written by `strava-mcp auth` and rewritten after every refresh (Strava rotates refresh tokens). Preferred over the variables below when it exists. |
| `STRAVA_REFRESH_TOKEN` | unset | A refresh token from your own OAuth flow; used only when the token file has none. |
| `STRAVA_ACCESS_TOKEN` | unset | A current access token (one is minted from the refresh token otherwise). |
| `STRAVA_API_BASE` | `https://www.strava.com/api/v3` | Strava moves the API to `https://api-v3.strava.com` (available from 2027-01-04); set it to switch early. |
| `STRAVA_UNITS` | the athlete's preference | `metric` or `imperial`, for how the prompts format distances, paces and elevation. |

## MCP endpoint

| Variable | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `http` in the image, `stdio` otherwise | `http` serves Streamable HTTP at `/mcp` (and `/`); `stdio` is for clients that spawn the process. |
| `PORT` | `8000` | HTTP port inside the container. `STRAVA_MCP_PORT` (default `8000`) is the host port Compose publishes it on. |
| `MCP_BEARER_TOKEN` | required by Compose, optional otherwise | Bearer token clients must send on `/mcp`. Unset leaves the endpoint open, which is only acceptable on a network you trust. |
| `MCP_ALLOWED_HOSTS` | any | Comma-separated hostnames clients use in the `Host` header (DNS-rebinding protection). Set it when the server is reachable through a reverse proxy, e.g. `strava.example.com`. `localhost` and `127.0.0.1` are always allowed. |

## Snapshot and sync

| Variable | Default | Meaning |
|---|---|---|
| `SNAPSHOT_TOKEN` | unset | Serve the read-only snapshot at `GET /snapshot.duckdb`, and garmin-mcp's sync export at `GET /export/garmin-sync` ([Extras](extras.md#using-your-own)), to this bearer token. Unset: neither is served over HTTP. The Grafana and notebook profiles read the file from the volume and do not need it. |
| `STRAVA_SNAPSHOT_DIR` | `snapshot/` next to the mirror | Where the snapshot is published. |
| `STRAVA_WEBHOOK_URL` | unset | Public HTTPS URL for Strava's push events, with a secret path (`https://strava.example.com/webhook/<random>`). The server registers the subscription itself. Unset: the activity list is polled every 15 minutes. See [How sync works](sync.md#webhook). |
| `STRAVA_SYNC` | `on` | `off` disables the background sync and the snapshot timer: tools answer from the mirror and fetch what they are asked for. |
| `STRAVA_DB_PATH` | `/data/strava.duckdb` in the image, `./state/strava.duckdb` otherwise | The mirror file. Mount a volume. |

## Resources

| Variable | Default | Meaning |
|---|---|---|
| `DUCKDB_MEMORY_LIMIT` | `384MB` in the image | DuckDB's memory limit. The process needs roughly 300 MB on top of it. See [Operations](operations.md#memory). |
| `DUCKDB_THREADS` | `2` in the image | DuckDB threads. |
| `STRAVA_MCP_MEMORY` | `1g` | The container's memory limit in Compose. |

## Profiles

Only read when the profile is started.

| Profile | Variable | Default | Meaning |
|---|---|---|---|
| oauth | `OIDC_ISSUER` | required | Your identity provider's issuer URL (the `iss` claim of its tokens). |
| oauth | `OIDC_JWKS_URL` | `${OIDC_ISSUER}/jwks.json` | Its JWKS endpoint. The default fits Authelia; see [Authentication](authentication.md#providers) for others. |
| oauth | `OIDC_CLIENT_ID` | required | The client registered at the provider for this server. |
| oauth | `OIDC_AUDIENCE` | `OIDC_CLIENT_ID` | The `aud` claim access tokens must carry. |
| oauth | `PUBLIC_URL` | required | Where your TLS reverse proxy exposes the gateway, e.g. `https://strava.example.com`. The MCP URL is `PUBLIC_URL/mcp`. |
| oauth | `OAUTH_PORT` | `3000` | Host port of the gateway. |
| oauth | `MCP_BUFFER` | `33554432` | Largest JSON-RPC body the gateway accepts, in bytes (uploads are the only large ones). |
| grafana | `GRAFANA_PORT` | `3001` | Host port of Grafana. |
| grafana | `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` | `admin` / `admin` | Grafana's admin login. Change the password. |
| notebooks | `MARIMO_PORT` | `2718` | Host port of the notebook. |
| backup | `BACKUP_DIR` | `./backups` | Where archives are written on the host. |
| backup | `BACKUP_CRON_EXPRESSION` | `0 4 * * *` | Schedule (UTC). |
| backup | `BACKUP_RETENTION_DAYS` | `14` | Archives older than this are pruned. |

## Running without Docker

```sh
npx -y strava-mcp-server          # stdio transport, mirror in ./state/strava.duckdb
```

Set `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` and `STRAVA_TOKEN_FILE`, then run `npx -y --package strava-mcp-server strava-mcp-auth` once to write the token file. `MCP_TRANSPORT=http` serves HTTP on `PORT`. Each instance keeps its own mirror and its own share of the rate limits, so run one per account.
