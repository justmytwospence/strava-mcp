# Quickstart

Ten minutes from nothing to a server answering questions about your training. You need Docker with Compose v2.24 or later, a Strava account, and a host that stays on (the [requirements](index.md#requirements)).

## 1. Create a Strava API application

1. Open [strava.com/settings/api](https://www.strava.com/settings/api) and create an application (any name and category; the website can be anything).
2. Set **Authorization Callback Domain** to `localhost`. The authorization command below listens on `http://localhost:8765/callback`, and Strava only redirects to the registered domain.
3. Note the **Client ID** and **Client Secret**.
4. Optional but worth it: on the same page, upgrade the application's rate limits (self-service, no review): the default 100 reads per 15 minutes and 1,000 a day become 200 and 2,000 ([Strava's rate limits page](https://developers.strava.com/docs/rate-limits/)). The first sync goes twice as fast.

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

The server listens on `http://<host>:8000/mcp`, reports `{"status":"ok"}` at `/health`, and starts the first sync. Tools work from the first minute and fetch what the sync has not reached yet.

## 5. Connect a client

For Claude Code, with the token from `.env` (paste it, or `source .env` first so the variable is set in your shell):

```sh
claude mcp add --transport http strava http://<host>:8000/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Then ask for `strava_sync_status` to watch the sync, or just ask about last week. [Clients](clients.md) covers Claude Desktop, claude.ai, Cursor, VS Code, Codex, ChatGPT, Gemini CLI and pi; [Authentication](authentication.md) covers signing in with your own identity provider instead of a bearer token.

## The first sync

The mirror fills in phases, newest first, within Strava's rate limits, so what you ask about most (recent activities) is complete early and the long tail finishes on its own. How long each phase takes depends on the account and on the application's limits; the durations below are rough estimates for an account of a few thousand activities at the default limits (1,000 reads a day), and about half that with the free upgrade.

| Phase | Typically done within | What is fetched | Approximate read cost |
|---|---|---|---|
| Profile, zones, totals, routes, clubs, starred segments | minutes | One request each, a few more for long lists | A handful |
| The complete activity list | minutes | Summaries of every activity, 200 per page | 1 read per 200 activities |
| Details and streams, newest first | hours to days | Full detail (laps, splits, efforts) and full-resolution streams of each activity | About 1 read per activity detail plus a stream request. Missing stream rate headers mean unknown accounting, not free calls; known quota pools and reserves still apply |
| Zones | days | Heart-rate and power zone distribution, for activities that have them | 1 read per activity |
| Kudos, comments, photos | days | Only for activities whose counts are non-zero | 1 read each, when non-zero |
| Segments | days to weeks for segment-heavy riders | Detail and geometry of every segment you have an effort on | 2 reads per unique segment |
| Gear, route details and geometry, club details | alongside the above | | 1 to 2 reads each |

The sync keeps **at most 75% of each rate-limit window** (15-minute and daily) for itself and spreads that budget evenly over the window; the rest stays available for your questions, which also run first. A 429 pauses everything until the window resets. With the free upgrade to 2,000 reads a day, a 2,000-activity account with heart rate on most activities (about 2 reads per activity for detail and zones, plus social and segments) is largely mirrored in two or three days; at the default limits, roughly a week.

Watch it with `strava_sync_status`: `coverage` counts activities with detail, streams and zones against the total; `queue` lists what is still pending by kind with the top priority; `rate_limits` shows today's usage against the limits and when the windows reset. The Grafana dashboard's sync health row shows the same over time. [How sync works](sync.md) explains the priorities and the freshness rules.

## Optional profiles

Each profile is self-contained and starts with its own `--profile` flag; the default `up` never starts them.

```sh
docker compose --profile grafana up -d     # dashboards at http://127.0.0.1:3001
docker compose --profile notebooks up -d   # a marimo notebook at http://127.0.0.1:2718
docker compose --profile backup up -d      # nightly archives in ./backups
docker compose --profile oauth up -d       # OAuth 2.1 in front of /mcp, see Authentication
```

Grafana and the notebook are published on the loopback interface only, because they start without real authentication; see [Grafana, notebooks, backups](extras.md) for what each contains and how to expose them.
