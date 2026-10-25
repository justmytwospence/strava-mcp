# garmin-mcp and the export

[garmin-mcp](https://justmytwospence.github.io/garmin-mcp/) is the sibling project for Garmin Connect: a complete DuckDB mirror of the account (activities, the original FIT files, sleep, HRV, Body Battery, training status, devices, gear, workouts, courses), cache-first tools, a read-only snapshot, the same Compose profiles. The two servers complement each other: Strava has the social and segment side of your training and the routes you plan; Garmin has the physiology and the device.

They need no shared credentials. garmin-mcp's optional [Strava sync](https://justmytwospence.github.io/garmin-mcp/strava-sync/) reads what this server already mirrors, through the [export endpoint](../reference/export.md), and never talks to Strava, so it spends none of your Strava API quota. It does two things Garmin and Strava do not do for each other:

- **Titles.** When you name or rename an activity on Strava, the Garmin activity gets the same name. Garmin sends an activity to Strava once; a later rename on Strava never comes back.
- **Courses.** When you unstar a Strava route, the course Strava's own sync created for it is deleted from Garmin Connect. Strava adds a course when you star a route but never removes one, so courses for routes you no longer want pile up on the watch.

## Setting it up

On this server, set `SNAPSHOT_TOKEN` (the export is served to that bearer) and, if you want unstarred routes to reach Garmin promptly, lower the route-list poll:

```ini
SNAPSHOT_TOKEN=...                   # openssl rand -hex 32
STRAVA_ROUTES_INTERVAL_MINUTES=15    # default 60; Strava sends no event for starring
```

On garmin-mcp, point its sync at the export with the same token (names per [its configuration page](https://justmytwospence.github.io/garmin-mcp/configuration/#strava-sync-optional)):

```ini
STRAVA_SYNC=titles,courses
STRAVA_EXPORT_URL=http://strava-mcp:8000/export/sync
STRAVA_SNAPSHOT_TOKEN=<the SNAPSHOT_TOKEN above>
```

When both run in the same Compose project or network, `http://strava-mcp:8000` resolves directly; across hosts use the server's own port or a reverse proxy route for `/export/`, not the oauth gateway. Where garmin-mcp's documentation names the path `/export/garmin-sync` (the name in strava-mcp 4.2), that works too: this server serves it as an alias.

## How fast a change travels

| Change on Strava | Reaches this mirror | Reaches Garmin Connect |
|---|---|---|
| Rename an activity | seconds with a webhook, within 15 minutes by polling | within a couple of minutes after that |
| Unstar a route | within `STRAVA_ROUTES_INTERVAL_MINUTES` (Strava sends no event) | within a couple of minutes after that |

Each route-list poll costs one or two reads. At 15 minutes that is up to 192 reads a day, about a fifth of the default daily read limit of 1,000; the free upgrade in Strava's API settings (2,000 reads a day) makes it a tenth. The default of an hour costs up to 48.

## Without the export

garmin-mcp can also read this server's snapshot (`snapshot/strava.duckdb` mounted read-only, or the `/snapshot.duckdb` URL with the same token) instead of the export; that works with any strava-mcp version but adds up to an hour, the snapshot's publish interval while the sync is idle, to every change.
