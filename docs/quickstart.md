# Quickstart

Ten minutes from nothing to a server answering questions about your training. You need Docker with Compose v2 and a Strava account.

## 1. Create a Strava API application

1. Open [strava.com/settings/api](https://www.strava.com/settings/api) and create an application (any name and category; the website can be anything).
2. Set **Authorization Callback Domain** to `localhost`. The authorization command below listens on `http://localhost:8765/callback`, and Strava only redirects to the registered domain.
3. Note the **Client ID** and **Client Secret**.

Each Strava API application serves one athlete here: the server mirrors the account that authorizes it.

## 2. Configure

```sh
git clone https://github.com/justmytwospence/strava-mcp.git
cd strava-mcp
cp .env.example .env
```

Edit `.env` and set the three required values:

```ini
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=...
MCP_BEARER_TOKEN=...      # openssl rand -hex 32
```

Everything else has a sensible default; [Configuration](configuration.md) describes it all.

## 3. Authorize once

```sh
docker compose run --rm -p 8765:8765 strava-mcp auth
```

Open the printed URL, sign in to Strava and allow access with every box ticked (the tools need `activity:read_all` to see private activities and `activity:write` to create or update them). Strava sends the browser to `http://localhost:8765/callback`, the command exchanges the code and writes `tokens.json` into the data volume. The server refreshes and rotates those tokens itself from then on.

??? tip "On a server without a browser"
    The browser must reach port 8765 on the machine running the command. Either forward it first (`ssh -L 8765:localhost:8765 your-server`) and open the URL on your laptop, or let the redirect fail and paste the URL from the browser's address bar (it contains the code) into the waiting command. `--no-listen` skips the listener entirely.

??? tip "Already have a refresh token?"
    Set `STRAVA_REFRESH_TOKEN` in `.env` instead and skip this step. The server writes the rotated pair to the token file after its first refresh and stops needing the variable.

## 4. Start

```sh
docker compose up -d
docker compose logs -f strava-mcp
```

The server listens on `http://<host>:8000/mcp`, reports `{"status":"ok"}` at `/health`, and starts the backfill: it lists every activity, then fetches details, streams and zones newest first, then the rest. With Strava's default limits (100 reads per 15 minutes, 1,000 a day) 2,000 activities take about a week; the free rate-limit upgrade in the API settings (200 / 2,000) halves that. Streams do not count against the limits. Tools work from the first minute and fetch what the backfill has not reached yet.

## 5. Connect a client

For Claude Code:

```sh
claude mcp add --transport http strava http://<host>:8000/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Then ask for `strava_sync_status` to watch the backfill, or just ask about last week. [Clients](clients.md) covers Claude Desktop, claude.ai, Cursor and pi; [Authentication](authentication.md) covers signing in with your own identity provider instead of a bearer token.

## Optional profiles

Each profile is self-contained and starts with its own `--profile` flag; the default `up` never starts them.

```sh
docker compose --profile grafana up -d     # dashboards at http://<host>:3001
docker compose --profile notebooks up -d   # a marimo notebook at http://<host>:2718
docker compose --profile backup up -d      # nightly archives in ./backups
docker compose --profile oauth up -d       # OAuth 2.1 in front of /mcp, see Authentication
```

See [Extras](extras.md) for what each contains.
