# Grafana, notebooks, backups

Each is a Compose profile over the snapshot, started with `docker compose --profile <name> up -d` and stopped with the same `--profile` and `down`. They mount the data volume read-only and never touch the live mirror. If you already run Grafana, marimo or a backup tool, the [last section](#using-your-own) shows how to point them at the snapshot instead.

## Grafana

```sh
docker compose --profile grafana up -d
```

Grafana 13 (the Ubuntu image, which MotherDuck's DuckDB datasource needs) on `http://127.0.0.1:3001`, login `admin` / `admin` unless `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` say otherwise.

!!! warning "Loopback only, by default"
    Because of that default login, the port is published on the loopback interface only. To reach Grafana from another machine, set a real `GRAFANA_ADMIN_PASSWORD`, then `GRAFANA_BIND=0.0.0.0` (or put a reverse proxy with TLS in front and leave the bind alone). Grafana has access to the whole snapshot, including private activities and GPS tracks.

The datasource plugin is installed at startup from its GitHub release and allowed as an unsigned plugin; the datasource `Strava` is provisioned over `/data/snapshot/strava.duckdb` read-only, and the plugin reopens the file when the server replaces it, so panels follow each new snapshot.

The provisioned dashboard **Strava** (folder Strava) has hours per week by sport, distance and elevation per week, average heart rate per activity, weekly run pace and ride speed, a recent activities table, and a sync health row: mirror coverage, job outcomes per hour, Strava API usage against the limits, recent errors. Dashboard times are the activities' local wall-clock times. Edit it freely or add your own; `deploy/grafana/dashboards/strava.json` is the source, and anything you save in the UI stays in the `grafana-data` volume.

Queries are plain DuckDB SQL with Grafana's macros, for example:

```sql
SELECT date_trunc('week', start_date_local) AS time, sport_type, sum(moving_time) / 3600.0 AS hours
FROM activity WHERE deleted_at IS NULL AND $__timeFilter(start_date)
GROUP BY 1, 2 ORDER BY 1
```

The first snapshot is published when the server starts (nearly empty on a fresh install), then at most hourly while the sync is idle and every six hours during a backfill, whenever the mirror changed; until the next publish the dashboard shows what the last one held.

## Notebooks

```sh
docker compose --profile notebooks up -d
```

A [marimo](https://marimo.io/) notebook served read-only (`marimo run`) on `http://127.0.0.1:2718`.

!!! warning "Loopback only, by default"
    The notebook runs without a token or login (`--no-token`): anyone who reaches the port can read everything in the snapshot and run the notebook's code. It is therefore published on the loopback interface only. To reach it from another machine, put something that authenticates in front of it (a reverse proxy with its own login, an SSH tunnel, a tailnet) and set `MARIMO_BIND=0.0.0.0`.

It shows volume and trends over a chosen number of weeks, the recent activities table, a map and elevation profile of any activity with GPS (the track comes from `activity_stream_point`), and sync health. It runs the same kind of analyses as the dashboard, as a starting point for your own. The notebook is `deploy/notebooks/strava.py`; copy it, edit it with `marimo edit`, and point `STRAVA_SNAPSHOT` at a snapshot file to run it anywhere with `duckdb`, `polars` and `altair` installed.

Each browser tab gets its own kernel and opens the snapshot when it starts; reload the page to see a newer snapshot.

## Backups

```sh
docker compose --profile backup up -d
```

[offen/docker-volume-backup](https://offen.github.io/docker-volume-backup/) archives the data volume into `./backups` (`BACKUP_DIR`) every night at 04:00 UTC (`BACKUP_CRON_EXPRESSION`) and prunes archives older than 14 days (`BACKUP_RETENTION_DAYS`). The live `strava.duckdb`, its write-ahead log and DuckDB's temporary files are excluded: the server has them open, and the snapshot is a complete copy. An archive contains:

```text
backup/strava/tokens.json
backup/strava/snapshot/strava.duckdb
```

To take one now: `docker compose --profile backup exec backup backup`.

### Restoring

With the stack stopped (`docker compose down`), put the files back into the volume and start again:

```sh
docker run --rm -v strava-mcp_strava-data:/data -v ./backups:/archive alpine sh -c \
  'cd /data && tar xzf /archive/strava-mcp-2026-10-20T04-00-00.tar.gz --strip-components=2 backup/strava/tokens.json backup/strava/snapshot/strava.duckdb && cp snapshot/strava.duckdb strava.duckdb'
docker compose up -d
```

The volume name is the Compose project name plus `_strava-data` (`docker volume ls`). Restoring the snapshot as the live file gives the server a mirror as of the archive; the sync fills in what happened since. Restoring only `tokens.json` is enough too: the server rebuilds the whole mirror from Strava, which takes as long as the first backfill did.

## Using your own

Everything above reads the snapshot; so can your own tools.

**Over HTTP.** Set `SNAPSHOT_TOKEN` and the server serves `GET /snapshot.duckdb` with range requests. From any DuckDB (CLI, Python, R, a Grafana running elsewhere whose DuckDB datasource gets an `initSql`):

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET strava (TYPE http, EXTRA_HTTP_HEADERS MAP {'Authorization': 'Bearer <SNAPSHOT_TOKEN>'});
ATTACH 'http://<host>:8000/snapshot.duckdb' AS strava (READ_ONLY);
```

**The live export.** With `SNAPSHOT_TOKEN` set, `GET /export/sync?since=<ISO time>` returns the starred routes and the activities since a time as a few kilobytes of JSON, live from the mirror rather than from the snapshot, to the same bearer token. [garmin-mcp](integrations/garmin-mcp.md) reads it; the [export API reference](reference/export.md) documents the contract for anything else.

**From the volume.** Mount the `strava-data` volume read-only into your container (`strava-mcp_strava-data:/data:ro` with the default project name) and open `/data/snapshot/strava.duckdb` read-only. For Grafana that is a datasource of type `motherduck-duckdb-datasource` with path `/data/snapshot/strava.duckdb?access_mode=read_only` on an Ubuntu-based Grafana image with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=motherduck-duckdb-datasource`; `deploy/grafana/` is a working example to copy from.

**What to back up.** `tokens.json` and `snapshot/strava.duckdb` in the volume. Never copy the live `strava.duckdb` while the server runs; it is not consistent on disk between checkpoints.
