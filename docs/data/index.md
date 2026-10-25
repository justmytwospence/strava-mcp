# The mirror and the snapshot

The mirror is one DuckDB file, `strava.duckdb` in the data volume. It has two layers.

## The raw store

Every response Strava returns is stored exactly as received, keyed by what it describes (`object_type`, e.g. `activity_detail`, and `object_key`, e.g. the activity id) and by the SHA-256 of its body. A new row is written only when the body changed, so `raw_payload` is also the edit history of every object: rename an activity on Strava and the mirror keeps both versions with their `fetched_at`. `raw_latest` says which version is current for each object and when Strava was last asked about it, including `not_found` for objects Strava answers 404 for (deleted activities, manual activities without streams).

Bodies over 4,000 bytes (activity streams, long activity details, route exports) are split into 4,000-byte chunks in `raw_blob`; `raw_payload.body` is `NULL` for them. The view `raw_current` joins the three and reassembles the body, so it is the one to query for raw JSON:

```sql
SELECT body->>'description', body->'gear'->>'name'
FROM raw_current
WHERE object_type = 'activity_detail' AND object_key = '1234567890';
```

Why chunks: DuckDB reads strings a vector of 2,048 rows at a time, and a lookup of one row of a vector that spans several string segments materializes every string in it. With multi-megabyte streams next to small summaries that cost hundreds of megabytes per lookup and gigabytes per scan; 4,000-byte chunks stay inline and compressed, and a vector of them is at most 8 MB. [Operations](../operations.md#memory) has the numbers.

## The typed layer

Each raw object type has a projection: SQL that rebuilds the typed rows derived from the current payloads of a set of keys. Landing a payload runs the projection for that key; rebuilding the whole mirror from `raw_payload` runs the same SQL for every key. The typed tables carry a description and unit on every column, visible through `strava_schema`, `duckdb_columns()`, or the [schema reference](schema.md).

The main ones:

| Table | Rows |
|---|---|
| `activity` | one per activity, summary and detail columns merged, `deleted_at` for deleted ones |
| `activity_lap`, `activity_split`, `activity_best_effort`, `activity_segment_effort` | children of the activity detail |
| `activity_stream_point` | one per recorded point, one column per channel (time, distance, lat, lng, altitude, velocity, heart rate, cadence, power, temperature, moving, grade) |
| `activity_zone`, `activity_zone_bucket` | heart-rate and power zone distributions |
| `activity_kudoer`, `activity_comment`, `activity_photo` | social |
| `athlete`, `athlete_zone`, `athlete_stats` | the profile, its zones, and a history of its totals |
| `gear`, `segment`, `segment_stream_point`, `segment_effort_stream_point` | equipment and segment geometry |
| `route`, `route_point`, `club` | routes with geometry, clubs |

Fields Strava adds later stay in the raw JSON; `strava_sync_status` lists the keys no typed column maps yet, so they can be added to `src/db/tables.ts` and backfilled from the raw store without another API call.

## Example queries

Weekly running volume for the year:

```sql
SELECT date_trunc('week', start_date_local) AS week,
       round(sum(distance) / 1000, 1) AS km, round(sum(moving_time) / 3600.0, 1) AS hours
FROM activity
WHERE deleted_at IS NULL AND sport_type IN ('Run', 'TrailRun') AND start_date_local >= '2026-01-01'
GROUP BY 1 ORDER BY 1;
```

Heart-rate drift in a long run (second half against first half):

```sql
WITH p AS (
  SELECT heartrate, velocity_smooth, idx, max(idx) OVER () AS n
  FROM activity_stream_point WHERE activity_id = 1234567890 AND heartrate IS NOT NULL)
SELECT avg(heartrate) FILTER (WHERE idx < n / 2) AS hr_first_half,
       avg(heartrate) FILTER (WHERE idx >= n / 2) AS hr_second_half,
       avg(velocity_smooth) FILTER (WHERE idx < n / 2) AS speed_first_half,
       avg(velocity_smooth) FILTER (WHERE idx >= n / 2) AS speed_second_half
FROM p;
```

Every effort on a segment, newest first:

```sql
SELECT e.start_date_local, e.elapsed_time, e.average_heartrate, e.pr_rank, a.name AS activity
FROM activity_segment_effort e JOIN activity a ON a.id = e.activity_id
WHERE e.segment_id = 229781 ORDER BY e.start_date DESC;
```

How the athlete's all-time totals grew:

```sql
SELECT fetched_at::DATE AS day, sport, count, round(distance / 1000) AS km
FROM athlete_stats WHERE period = 'all' ORDER BY fetched_at, sport;
```

## The snapshot

DuckDB allows one writing process, so nothing else can open the live file. The server publishes a consistent read-only copy to `snapshot/strava.duckdb` next to it: a byte copy taken under the write lock after a checkpoint, atomically replacing the previous one. The first copy is published at startup (nearly empty on a fresh install), then at most hourly while the sync is idle and every six hours during a backfill, whenever the mirror changed. Readers open it read-only, and several can at once.

With `SNAPSHOT_TOKEN` set it is also served at `GET /snapshot.duckdb` with range requests, so DuckDB's `httpfs` can attach it over HTTP from anywhere:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET strava (TYPE http, EXTRA_HTTP_HEADERS MAP {'Authorization': 'Bearer <SNAPSHOT_TOKEN>'});
ATTACH 'http://<host>:8000/snapshot.duckdb' AS strava (READ_ONLY);
SELECT sport_type, count(*) FROM strava.activity GROUP BY ALL;
```

Locally, or from a container that mounts the data volume read-only:

```sql
ATTACH '/data/snapshot/strava.duckdb' AS strava (READ_ONLY);
```

The snapshot is the file to back up and the file to hand to anything else; the live file is only ever touched by the server. See [Extras](../extras.md) for Grafana, marimo and backups over it.
