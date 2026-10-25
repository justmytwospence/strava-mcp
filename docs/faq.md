# FAQ

## Can it serve several athletes?

No. One server mirrors one account: the account that authorized the Strava API application. For a second athlete, run a second instance (another Compose project with its own `.env`, volume and port, or another stdio process) with its own API application. Strava's rate limits are per application, so two instances sharing one application would also share its budget.

## Can I run it without Docker?

Yes. The npm package runs the same server over stdio, for a client that spawns it on the machine you are sitting at:

```sh
STRAVA_CLIENT_ID=12345 STRAVA_CLIENT_SECRET=... npx -y --package @justmytwospence/strava-mcp strava-mcp-auth
npx -y @justmytwospence/strava-mcp
```

The mirror and the token file live in `./state/` under the working directory unless `STRAVA_DB_PATH` and `STRAVA_TOKEN_FILE` say otherwise; `MCP_TRANSPORT=http` serves HTTP instead. Each process keeps its own mirror and its own share of the rate limits, and the sync only runs while the process does, so a laptop that sleeps overnight backfills more slowly than an always-on container. [Clients](clients.md) shows the configuration for Claude Desktop and others.

## Which clients work?

Anything that speaks MCP over Streamable HTTP or stdio: Claude Code, Claude Desktop, claude.ai, Cursor, VS Code, Codex, ChatGPT, Gemini CLI, pi and more. [Clients](clients.md) has a configuration for each. claude.ai and ChatGPT need a public HTTPS URL and OAuth, which the `oauth` profile provides.

## What happens when I edit or delete something on Strava?

With a webhook, Strava tells the server within seconds that an activity was created, edited or deleted, and the server re-fetches it. Without one, the activity list is polled every 15 minutes and relisted over 90 days daily, so edits reach the mirror within those windows. A deleted activity is marked `deleted_at` in the `activity` table and left out of every tool and export; its last payload stays in the raw store as history. A full relisting once a week catches deletions the webhook missed. Starring or unstarring a route sends no event, so the route list is polled on its own schedule (`STRAVA_ROUTES_INTERVAL_MINUTES`, an hour by default).

## Can I export my data?

The mirror is a DuckDB file, so any DuckDB client exports it: the snapshot at `snapshot/strava.duckdb` in the data volume (or over HTTP with `SNAPSHOT_TOKEN`) opens read-only from the DuckDB CLI, Python, R, Grafana or a notebook, and `COPY (SELECT ...) TO 'activities.parquet'` or `.csv` does the rest. The `backup` profile archives the snapshot and the token file on a schedule. For the files Strava itself holds (original uploads, photos at full size), use [Strava's own export](https://support.strava.com/hc/en-us/articles/216918437-Exporting-your-Data-and-Bulk-Export).

## What does it cost?

The software is free (MIT). Running it costs whatever your host costs; the container is small. Strava's API is free to use within its limits, but since June 2026 Strava requires a Strava subscription for Standard-tier API access ([Strava's announcement](https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428)); check the [API settings page](https://www.strava.com/settings/api) for what applies to your account.

## Is this allowed under Strava's terms?

Read them yourself: the [API Agreement](https://www.strava.com/legal/api), the [API Policy](https://www.strava.com/legal/api_policy) it incorporates, and the [brand guidelines](https://developers.strava.com/guidelines/). The policy limits caching Strava data to seven days (section 6.2), prohibits storing it in persistent databases and indexes (5.5), and names Strava's own MCP connector as the sole authorized agent-mediated interface (5.16). strava-mcp keeps a complete local copy of one athlete's own data and exposes it to that athlete's own AI client, which is what those sections restrict. The project is built for personal use of your own data on your own hardware, with no third party involved; whether that use is acceptable to you under the agreement you accepted when creating the API application is your decision. This project is not affiliated with Strava.

## How long does the first sync take?

It depends on the size of the account and on the rate limits of your API application. Roughly: the profile and recent activities within minutes, activity details and streams over hours to days (newest first, so recent questions work early), zones and social data over days, and segments over weeks for segment-heavy riders. The [first sync section of the quickstart](quickstart.md#the-first-sync) has a phase table with per-phase costs, and `strava_sync_status` shows progress.

## What does the model provider see?

Whatever the tools return. An MCP client sends tool results to the model, so when you ask Claude, ChatGPT or Gemini about your training, the activity details, streams, locations and names the tools return for that question are sent to that provider under its terms. The server itself sends nothing anywhere but Strava's API and, with the `oauth` profile, your identity provider's JWKS endpoint. If you want to keep some data local, use `strava_query` with aggregating SQL, or a local model.

## Does it use the streams' full resolution?

Yes. Every activity's streams are mirrored at the resolution Strava returns (one point per recorded second for most devices) into `activity_stream_point`, one row per point. The stream tools downsample to `max_points` for the model; SQL sees every point.

## Why does an answer say "stale"?

The tool wanted to refresh the stored copy, Strava could not be asked right now (rate limit, outage), and the stored copy was served instead, marked `[stale: ...]`. The sync will refresh it when Strava is available again. [Troubleshooting](troubleshooting.md#rate-limits) explains how to see the current budget.

## Can I use my own Grafana, notebook or backup tool?

Yes: everything reads the snapshot, and so can your tools, from the volume or over HTTP. [Grafana, notebooks, backups](extras.md#using-your-own) shows how.
