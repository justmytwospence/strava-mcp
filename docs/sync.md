# How sync works

The sync engine is a durable job queue inside the mirror, one worker that drains it within Strava's rate limits, a planner that turns gaps in the mirror into jobs, and a scheduler for the periodic listings. It costs no API requests to plan; only running a job does.

## Rate limits

Strava enforces two pairs of limits, overall and non-upload reads, each with a 15-minute and a daily window (100 / 1,000 by default; 200 / 2,000 after the free upgrade in the API settings). The 15-minute windows reset at :00, :15, :30 and :45 UTC, the daily one at midnight UTC. Usage is read from the `X-RateLimit-*` and `X-ReadRateLimit-*` headers of every response, carried forward, and reset at window boundaries; it survives restarts through the `rate_sample` table.

Each priority class may use only part of a window, so background work can never starve a person:

| Class | Who | Share of the 15-minute window | Share of the day |
|---|---|---|---|
| interactive | tools, resources, prompts | 98% | 99.5% |
| incremental | new activities, anything from the last week | 85% | 90% |
| backfill | everything older | 75% | 75% |

Backfill also spreads what it may use evenly over the rest of each window rather than bursting. A 429 pauses every class until the next 15-minute boundary, or until midnight when a daily limit is spent. Some endpoints (activity streams, observed from their missing headers) do not count; they are only lightly paced.

## Priorities

Lower runs first; within a priority, newer activities first.

| Priority | Work |
|---|---|
| 5 | On-demand: refreshes queued by tools and webhook events |
| 10 | New activities, and details and streams of the last week |
| 15 | Profile, zones, stats, routes, clubs, starred segments |
| 20 | Backfill: activity details and streams, newest first |
| 21 | Backfill: zones |
| 25 | Gear and route details, the weekly full listing |
| 30 | Kudos, comments, photos |
| 35 | Club details |
| 40 | Segment details and geometry |

Priorities below 10 use the interactive class, below 20 incremental, the rest backfill.

## Schedule

| Task | Every | What it does |
|---|---|---|
| `list_recent` | 15 min (6 h with a webhook) | Lists activities since two days before the newest stored one; catches late uploads and fresh edits |
| `list_window` | day | Relists the last 90 days to find edits |
| `list_full` | week | Lists everything; activities missing from it are marked deleted |
| `athlete`, `athlete_stats` | 6 h | Profile and totals (the totals keep a history) |
| `routes` | 15 min | Routes and their starred flag (Strava sends no webhook for starring a route) |
| `athlete_zones`, `starred_segments`, `clubs` | day | |

After every listing the planner compares the mirror with what it should hold and queues the differences: a detail that was never fetched or whose summary changed since, streams and zones that are missing, social payloads whose count on the activity disagrees with what is stored, gear older than a week, routes updated since their last fetch, segments seen in efforts but never fetched. Planning twice adds nothing.

A failed job is retried with exponential backoff (2, 4, 8 ... minutes, capped at a day) and its error is kept in `sync_job` and `sync_log`; `strava_sync_status` shows both.

## Freshness and provenance

Every read tool goes through the same rule: serve the stored copy if it is younger than the maximum age for its kind, fetch (at interactive priority) otherwise, and if Strava cannot be asked right now (rate limit, outage) serve the stored copy marked stale.

| Data | Served from the mirror while |
|---|---|
| Activity list | listed within the last 15 minutes |
| Activity detail | younger than 15 minutes for activities under two days old, 6 hours under two weeks, forever after, and refetched whenever its summary shows a change |
| Streams, zones, segment efforts and their streams | forever (they never change) |
| Kudos, comments, photos | until the count on the activity disagrees, hourly for a week |
| Athlete profile | 6 hours; zones a day; stats an hour |
| Gear, clubs | a day; segments a week |
| Routes | until the route list reports an update |

Each result ends with a line such as `[served from the local mirror (fetched from Strava 2026-10-20T08:12:00Z)]`, `[fetched from Strava just now]`, or `[served from the local mirror ...] [stale: Strava could not be asked: ...]`, so the model and the reader know what they are looking at.

Writes (`strava_update_activity`, `strava_create_activity`, `strava_star_segment`, uploads) go to Strava first; the response is stored like any other payload, and a listing is queued so the mirror catches up with anything derived from it.

## Webhook

Without a public URL the server learns about new activities by listing every 15 minutes. With `STRAVA_WEBHOOK_URL` set to a public HTTPS URL with a secret path, it registers Strava's push subscription for the application at startup (replacing one that points elsewhere, since an application has only one), validates Strava's challenge, and from then on a created, edited or deleted activity is queued within seconds. The listing then only runs every six hours as a safety net.

The callback is authenticated by its path and by the subscription and athlete ids in each event; an event only queues a re-fetch from the API and is never stored as data, so the worst an attacker who guesses the path can do is cause a few extra requests. `strava_sync_status` reports the subscription state and the last event.

```ini
STRAVA_WEBHOOK_URL=https://strava.example.com/webhook/4f1c0e3b9a7d2e5c
```

The path after the host is yours to choose; make it long and random (`openssl rand -hex 16`). The host must resolve publicly and present a valid certificate, since Strava calls it.

=== "Reverse proxy"

    If `strava.example.com` already reaches the server (or the oauth gateway) through nginx, Caddy or Traefik, route only the webhook path to port 8000 and leave the rest as it is. Caddy:

    ```text
    strava.example.com {
        handle /webhook/* {
            reverse_proxy strava-mcp:8000
        }
        handle {
            reverse_proxy oauth:3000
        }
    }
    ```

    Set `MCP_ALLOWED_HOSTS=strava.example.com` so the server accepts that `Host`.

=== "Cloudflare Tunnel"

    Create a tunnel in the Cloudflare dashboard (Networking, Tunnels) with a public hostname `strava.example.com` pointing at `http://strava-mcp:8000`, add `cloudflared` to the stack and set the webhook URL on that hostname:

    ```yaml
    # compose.override.yaml
    services:
      cloudflared:
        image: cloudflare/cloudflared:2026.10.1
        restart: unless-stopped
        command: tunnel --no-autoupdate run
        environment:
          TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    ```

    Everything under that hostname is then public, including `/mcp` (protected by the bearer token or the gateway). To expose only the webhook, give the tunnel's public hostname a path rule for `/webhook/*` and no catch-all.

=== "Tailscale Funnel"

    On the host running Docker, with Funnel enabled for the tailnet:

    ```sh
    sudo tailscale funnel --bg --https=443 --set-path=/webhook http://127.0.0.1:8000/webhook
    ```

    gives `https://<machine>.<tailnet>.ts.net/webhook/...` a public HTTPS front for that path only. Funnel strips the mount path before proxying, which is why the target repeats `/webhook`: Strava's `/webhook/<secret>` then arrives at the server unchanged. Set `STRAVA_WEBHOOK_URL=https://<machine>.<tailnet>.ts.net/webhook/<secret>` and `MCP_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net`. `/mcp` stays reachable only inside the tailnet (`tailscale serve --bg localhost:8000` publishes it there).

## Watching it

`strava_sync_status` returns the coverage (activities, with detail, with streams, with zones), the queue by kind with the top priority and retry counts, the last run of each periodic task, the outcomes of the last 24 hours, the last errors, the rate-limit usage of both pools, the webhook state, and any fields Strava returned that no typed column maps yet. The Grafana dashboard's sync health row shows the same over time.
