/**
 * Projections: raw payloads -> typed tables.
 *
 * Each raw object type has one projection that (re)builds the typed rows derived from
 * the current payloads of a set of keys, so landing a payload and rebuilding the whole
 * mirror from raw_payload run the same SQL. Projections run inside the caller's
 * transaction on the writer connection; the keys in scope sit in the temp table
 * _scope.
 */
import { listValue } from "@duckdb/node-api";
import type { Tx } from "./database.js";
import { BODY_EXPR, bodyExpr } from "./schema.js";
import { type Column, type Table, consumedKeys, selectList, table } from "./tables.js";

const SCOPE = "(SELECT object_key FROM _scope)";

/**
 * raw_current restricted to the scoped keys of one type. The scope is applied to
 * raw_latest and raw_payload before the join, and the chunked bodies are read with the
 * same correlated subquery as the view (schema.ts), which only touches the chunks of the
 * scoped keys.
 */
function scopedRaw(type: string): string {
  return `(SELECT l.object_type, l.object_key, l.status, l.checked_at, p.fetched_at, ${BODY_EXPR} AS body
    FROM (SELECT * FROM raw_latest WHERE object_type = '${type}' AND object_key IN ${SCOPE}) l
    LEFT JOIN (SELECT * FROM raw_payload WHERE object_type = '${type}' AND object_key IN ${SCOPE}) p USING (object_type, object_key, content_hash))`;
}

/** The current body of a sample of the newest objects of one type, for the drift check. */
function liveBodies(type: string): string {
  const sample = DRIFT_SAMPLE[type] ?? DRIFT_SAMPLE_DEFAULT;
  return `(SELECT l.object_key, p.fetched_at, ${BODY_EXPR} AS body
    FROM (SELECT * FROM raw_latest WHERE object_type = '${type}' AND status = 'ok' ORDER BY checked_at DESC LIMIT ${sample}) l
    JOIN raw_payload p USING (object_type, object_key, content_hash))`;
}

/**
 * How many of the newest payloads of a type the drift check parses. New fields show up
 * in new payloads, and parsing everything is expensive: DuckDB parses a whole vector of
 * rows at once, outside its memory limit, and a parsed payload is many times its text.
 * Streams get a small sample; their keys are fixed by the API.
 */
const DRIFT_SAMPLE_DEFAULT = 200;
const DRIFT_SAMPLE: Record<string, number> = {
  activity_streams: 10,
  segment_streams: 10,
  segment_effort_streams: 10,
  route_streams: 10,
};

function current(type: string, alias = "r"): string {
  return `(SELECT * FROM ${scopedRaw(type)} WHERE body IS NOT NULL) ${alias}`;
}

function insert(t: Table, from: string, only?: (c: Column) => boolean, conflict = "OR REPLACE"): string {
  const { names, exprs } = selectList(t, only);
  // A table without an enforced key has nothing to conflict with: its projection deletes first.
  const mode = t.keyEnforced === false ? "" : conflict;
  return `INSERT ${mode} INTO ${t.name} (${names})\n  SELECT\n    ${exprs}\n  FROM ${from}`;
}

/** Upsert that only overwrites the given columns of an existing row. */
function upsert(t: Table, from: string, only: (c: Column) => boolean): string {
  const { names, exprs } = selectList(t, only);
  const updates = t.columns
    .filter(only)
    .filter((c) => !t.primaryKey.includes(c.name))
    .map((c) => `"${c.name}" = excluded."${c.name}"`)
    .join(", ");
  return `INSERT INTO ${t.name} (${names})\n  SELECT\n    ${exprs}\n  FROM ${from}\n  ON CONFLICT (${t.primaryKey.map((k) => `"${k}"`).join(", ")}) DO UPDATE SET ${updates}`;
}

/** Child rows unnested from an array at `path` of each payload. */
function children(type: string, arrayExpr: string, extra = ""): string {
  return `(SELECT r.object_key, r.fetched_at${extra ? `, ${extra}` : ""}, unnest(CAST(${arrayExpr} AS JSON[])) AS b FROM ${current(type)}) src`;
}

const STREAM_CASTS: Record<string, string> = {
  time: "INTEGER[]",
  distance: "DOUBLE[]",
  latlng: "DOUBLE[][]",
  altitude: "DOUBLE[]",
  velocity_smooth: "DOUBLE[]",
  heartrate: "INTEGER[]",
  cadence: "INTEGER[]",
  watts: "INTEGER[]",
  temp: "INTEGER[]",
  moving: "BOOLEAN[]",
  grade_smooth: "DOUBLE[]",
};

const STREAM_KEYS = Object.keys(STREAM_CASTS);

/**
 * Zip the per-channel arrays of a key_by_type streams payload into one row per point.
 * Missing channels unnest to null alongside the present ones.
 *
 * Without `bodyFor`, the payload is keyed by type and every channel's data array is pulled
 * out by one multi-path json_extract: DuckDB parses the JSON afresh for each extraction, and
 * a long activity's streams (megabytes of JSON, ten channels) otherwise need several
 * hundred MB.
 */
function streamPoints(type: string, idColumn: string, keys: string[], bodyFor?: (key: string) => string): string {
  const source = bodyFor
    ? current(type)
    : `(SELECT r.object_key, r.fetched_at, json_extract(r.body, [${keys.map((k) => `'$.${k}.data'`).join(", ")}]) AS __d FROM ${current(type)}) r`;
  const expr = (k: string) => (bodyFor ? bodyFor(k) : `r.__d[${keys.indexOf(k) + 1}]`);
  const lists = keys.map((k) => `TRY_CAST(${expr(k)} AS ${STREAM_CASTS[k]}) AS "${k}"`).join(", ");
  const lengths = keys.map((k) => `coalesce(len("${k}"), 0)`).join(", ");
  const unnests = keys
    .map((k) => (k === "latlng" ? `unnest("latlng") AS latlng` : `unnest("${k}") AS "${k}"`))
    .join(", ");
  const outer = keys.flatMap((k) => (k === "latlng" ? ["latlng[1] AS lat", "latlng[2] AS lng"] : [`"${k}"`])).join(", ");
  return `(SELECT ${idColumn}, fetched_at, idx, ${outer} FROM (
      SELECT ${idColumn}, fetched_at, unnest(range(greatest(${lengths}))) AS idx, ${unnests}
      FROM (SELECT r.object_key::BIGINT AS ${idColumn}, r.fetched_at, ${lists} FROM ${source})
    )) s`;
}

export interface Projection {
  /** Raw object type this projection reads. */
  type: string;
  /** SQL statements, run in order with _scope filled. */
  statements: string[];
  /**
   * For the drift check: SQL yielding JSON objects (column `o`) from the current
   * payloads of this type, or directly their key names (column `k`, for objects too big
   * to extract), with the keys the projection understands.
   */
  shapes: Array<{ objects?: string; keys?: string; known: Set<string> }>;
}

const IGNORED = ["resource_state", "id_str"];

function known(t: Table | Table[], ...extra: string[]): Set<string> {
  const tables = Array.isArray(t) ? t : [t];
  const keys = new Set([...IGNORED, ...extra]);
  for (const x of tables) for (const k of consumedKeys(x)) keys.add(k);
  return keys;
}

function objects(type: string, path?: string): string {
  const inner = `SELECT body FROM ${liveBodies(type)} WHERE body IS NOT NULL`;
  if (!path) return `SELECT body AS o FROM (${inner}) WHERE json_type(body) = 'OBJECT'`;
  return `SELECT unnest(CAST(json_extract(body, '${path}') AS JSON[])) AS o FROM (${inner})`;
}

const activity = table("activity");
const effort = table("activity_segment_effort");
const best = table("activity_best_effort");
const lap = table("activity_lap");
const split = table("activity_split");
const zone = table("activity_zone");
const bucket = table("activity_zone_bucket");
const kudoer = table("activity_kudoer");
const comment = table("activity_comment");
const photo = table("activity_photo");
const streamMeta = table("activity_stream_meta");
const streamPoint = table("activity_stream_point");
const athlete = table("athlete");
const athleteZone = table("athlete_zone");
const athleteStats = table("athlete_stats");
const gear = table("gear");
const segment = table("segment");
const segmentPoint = table("segment_stream_point");
const effortPoint = table("segment_effort_stream_point");
const route = table("route");
const routePoint = table("route_point");
const club = table("club");

/** The scope's keys as ids (activity, segment, effort or route ids, per projection). */
const activityIds = `(SELECT object_key::BIGINT FROM _scope)`;

/** Activity rows merge the newest of the summary and the detail payload. */
const activitySource = `(
  SELECT
    coalesce(s.object_key, d.object_key) AS object_key,
    CASE WHEN d.body IS NOT NULL AND (s.body IS NULL OR d.checked_at >= s.checked_at) THEN d.body ELSE s.body END AS b,
    d.body AS d,
    s.checked_at AS summary_fetched_at,
    d.checked_at AS detail_fetched_at,
    CASE
      WHEN s.status = 'not_found' OR d.status = 'not_found'
      THEN greatest(CASE WHEN s.status = 'not_found' THEN s.checked_at END, CASE WHEN d.status = 'not_found' THEN d.checked_at END)
    END AS deleted_at
  FROM ${scopedRaw("activity_summary")} s
  FULL JOIN ${scopedRaw("activity_detail")} d
    USING (object_key)
) src WHERE b IS NOT NULL`;

const activityRow = insert(activity, activitySource);

const segmentSummary = (c: Column) =>
  !["total_elevation_gain", "created_at", "updated_at", "polyline", "effort_count", "athlete_count", "star_count",
    "athlete_segment_stats", "xoms", "local_legend", "detail_fetched_at", "starred_date", "pr_time", "athlete_pr_effort"].includes(c.name);

const gearSummary = (c: Column) =>
  ["id", "kind", "name", "nickname", "primary", "retired", "distance", "converted_distance", "fetched_at"].includes(c.name);

const clubSummary = (c: Column) => !["description", "club_type", "following_count", "website", "detail_fetched_at"].includes(c.name);

const routeSummary = (c: Column) => !["polyline", "segments", "detail_fetched_at"].includes(c.name);

export const PROJECTIONS: Projection[] = [
  {
    type: "activity_summary",
    statements: [activityRow],
    shapes: [{ objects: objects("activity_summary"), known: known(activity) }],
  },
  {
    type: "activity_detail",
    statements: [
      activityRow,
      `DELETE FROM activity_lap WHERE activity_id IN ${activityIds}`,
      insert(lap, children("activity_detail", "r.body->'laps'")),
      `DELETE FROM activity_split WHERE activity_id IN ${activityIds}`,
      insert(
        split,
        `(SELECT r.object_key::BIGINT AS activity_id, r.fetched_at, u.units, unnest(CAST(r.body->(u.key) AS JSON[])) AS b
          FROM ${current("activity_detail")}, (VALUES ('metric', 'splits_metric'), ('standard', 'splits_standard')) u(units, key)) src`,
      ),
      `DELETE FROM activity_best_effort WHERE activity_id IN ${activityIds}`,
      insert(best, children("activity_detail", "r.body->'best_efforts'")),
      `DELETE FROM activity_segment_effort WHERE activity_id IN ${activityIds}`,
      insert(effort, children("activity_detail", "r.body->'segment_efforts'")),
      // Embedded segment summaries only fill segments not seen before.
      insert(
        segment,
        `(SELECT DISTINCT ON (b->>'id') fetched_at, NULL::TIMESTAMPTZ AS detail_fetched_at, b FROM (
            SELECT r.fetched_at, unnest(CAST(json_extract(r.body, '$.segment_efforts[*].segment') AS JSON[])) AS b FROM ${current("activity_detail")})) src`,
        segmentSummary,
        "OR IGNORE",
      ),
    ],
    shapes: [
      { objects: objects("activity_detail"), known: known(activity, "laps", "splits_metric", "splits_standard", "best_efforts", "segment_efforts") },
      { objects: objects("activity_detail", "$.laps"), known: known(lap) },
      { objects: objects("activity_detail", "$.splits_metric"), known: known(split) },
      { objects: objects("activity_detail", "$.best_efforts"), known: known(best) },
      { objects: objects("activity_detail", "$.segment_efforts"), known: known(effort) },
      { objects: `SELECT json_extract(o, '$.segment') AS o FROM (${objects("activity_detail", "$.segment_efforts")})`, known: known(segment) },
    ],
  },
  {
    type: "activity_streams",
    statements: [
      `DELETE FROM activity_stream_meta WHERE activity_id IN ${activityIds}`,
      insert(
        streamMeta,
        // Only the three scalars of each stream, in one extraction: r.body->k would copy
        // each channel's whole data array (megabytes for a long activity).
        `(SELECT activity_id, fetched_at, k AS stream_type,
                 json_object('original_size', m[3 * i + 1], 'resolution', m[3 * i + 2], 'series_type', m[3 * i + 3]) AS b
          FROM (SELECT r.object_key::BIGINT AS activity_id, r.fetched_at,
                       json_extract_string(r.body, [${STREAM_KEYS.flatMap((k) => [`'$.${k}.original_size'`, `'$.${k}.resolution'`, `'$.${k}.series_type'`]).join(", ")}]) AS m
                FROM ${current("activity_streams")} WHERE json_type(r.body) = 'OBJECT'),
               unnest([${STREAM_KEYS.map((k) => `'${k}'`).join(", ")}]) WITH ORDINALITY AS t(k, o), LATERAL (SELECT (o - 1)::INTEGER AS i)
          WHERE m[3 * i + 1] IS NOT NULL OR m[3 * i + 3] IS NOT NULL) src`,
      ),
      `DELETE FROM activity_stream_point WHERE activity_id IN ${activityIds}`,
      insert(
        streamPoint,
        streamPoints("activity_streams", "activity_id", Object.keys(STREAM_CASTS)),
      ),
    ],
    shapes: [
      { objects: objects("activity_streams"), known: new Set(Object.keys(STREAM_CASTS)) },
      {
        // Key names of each stream object, without extracting the (large) data arrays.
        keys: `SELECT unnest(flatten(list_filter(json_keys(body, [${Object.keys(STREAM_CASTS).map((k) => `'$.${k}'`).join(", ")}]), x -> x IS NOT NULL))) AS k
               FROM ${liveBodies("activity_streams")} WHERE body IS NOT NULL AND json_type(body) = 'OBJECT'`,
        known: known(streamMeta, "data"),
      },
    ],
  },
  {
    type: "activity_zones",
    statements: [
      `DELETE FROM activity_zone WHERE activity_id IN ${activityIds}`,
      insert(
        zone,
        `(SELECT r.object_key::BIGINT AS activity_id, r.fetched_at, unnest(CAST(r.body AS JSON[])) AS b FROM ${current("activity_zones")}) src`,
      ),
      `DELETE FROM activity_zone_bucket WHERE activity_id IN ${activityIds}`,
      insert(
        bucket,
        `(SELECT activity_id, fetched_at, type, unnest(range(len(buckets))) AS bucket_index, unnest(buckets) AS b FROM (
            SELECT r.object_key::BIGINT AS activity_id, r.fetched_at, z->>'type' AS type, CAST(z->'distribution_buckets' AS JSON[]) AS buckets
            FROM ${current("activity_zones")}, unnest(CAST(r.body AS JSON[])) t(z))) src`,
      ),
    ],
    shapes: [
      { objects: objects("activity_zones", "$[*]"), known: known(zone) },
      { objects: `SELECT unnest(CAST(json_extract(o, '$.distribution_buckets') AS JSON[])) AS o FROM (${objects("activity_zones", "$[*]")})`, known: known(bucket) },
    ],
  },
  {
    type: "activity_kudos",
    statements: [
      `DELETE FROM activity_kudoer WHERE activity_id IN ${activityIds}`,
      insert(
        kudoer,
        `(SELECT r.object_key::BIGINT AS activity_id, r.fetched_at, unnest(range(json_array_length(r.body)::BIGINT)) AS idx, unnest(CAST(r.body AS JSON[])) AS b FROM ${current("activity_kudos")}) src`,
      ),
    ],
    shapes: [{ objects: objects("activity_kudos", "$[*]"), known: known(kudoer) }],
  },
  {
    type: "activity_comments",
    statements: [
      `DELETE FROM activity_comment WHERE activity_id IN ${activityIds}`,
      insert(comment, children("activity_comments", "r.body")),
    ],
    shapes: [{ objects: objects("activity_comments", "$[*]"), known: known(comment, "activity_id_str", "cursor") }],
  },
  {
    type: "activity_photos",
    statements: [
      `DELETE FROM activity_photo WHERE activity_id IN ${activityIds}`,
      insert(photo, children("activity_photos", "r.body")),
    ],
    shapes: [{ objects: objects("activity_photos", "$[*]"), known: known(photo, "activity_name", "athlete_id", "post_id", "placeholder_image", "cursor") }],
  },
  {
    type: "athlete",
    statements: [
      `DELETE FROM athlete`,
      insert(athlete, `(SELECT r.fetched_at, r.body AS b FROM ${current("athlete")}) src`),
      upsert(
        gear,
        `(SELECT r.fetched_at, NULL::TIMESTAMPTZ AS detail_fetched_at, unnest(CAST(list_concat(CAST(r.body->'bikes' AS JSON[]), CAST(r.body->'shoes' AS JSON[])) AS JSON[])) AS b FROM ${current("athlete")}) src`,
        gearSummary,
      ),
      upsert(
        club,
        `(SELECT r.fetched_at, NULL::TIMESTAMPTZ AS detail_fetched_at, unnest(CAST(r.body->'clubs' AS JSON[])) AS b FROM ${current("athlete")}) src`,
        clubSummary,
      ),
    ],
    shapes: [
      { objects: objects("athlete"), known: known(athlete, "bikes", "shoes", "clubs") },
      { objects: objects("athlete", "$.bikes"), known: known(gear) },
      { objects: objects("athlete", "$.shoes"), known: known(gear) },
      { objects: objects("athlete", "$.clubs"), known: known(club) },
    ],
  },
  {
    type: "athlete_zones",
    statements: [
      `DELETE FROM athlete_zone`,
      insert(
        athleteZone,
        `(SELECT r.fetched_at, k.kind, TRY_CAST(r.body->(k.kind)->>'custom_zones' AS BOOLEAN) AS custom_zones,
            unnest(range(json_array_length(r.body->(k.kind)->'zones')::BIGINT)) AS zone_index,
            unnest(CAST(r.body->(k.kind)->'zones' AS JSON[])) AS b
          FROM ${current("athlete_zones")}, (VALUES ('heart_rate'), ('power')) k(kind)
          WHERE (r.body->(k.kind)) IS NOT NULL) src`,
      ),
    ],
    shapes: [
      { objects: objects("athlete_zones"), known: new Set(["heart_rate", "power"]) },
      { objects: `SELECT json_extract(body, '$.heart_rate') AS o FROM ${liveBodies("athlete_zones")} WHERE body IS NOT NULL`, known: new Set(["custom_zones", "zones"]) },
      { objects: `SELECT json_extract(body, '$.power') AS o FROM ${liveBodies("athlete_zones")} WHERE body IS NOT NULL`, known: new Set(["zones"]) },
      { objects: objects("athlete_zones", "$.heart_rate.zones"), known: known(athleteZone) },
    ],
  },
  {
    // History: every stored version, not only the current one.
    type: "athlete_stats",
    statements: [
      `DELETE FROM athlete_stats`,
      insert(
        athleteStats,
        `(SELECT p.fetched_at, t.period, t.sport, p.body->(t.period || '_' || t.sport || '_totals') AS b,
            TRY_CAST(p.body->>'biggest_ride_distance' AS DOUBLE) AS biggest_ride_distance,
            TRY_CAST(p.body->>'biggest_climb_elevation_gain' AS DOUBLE) AS biggest_climb_elevation_gain
          FROM (SELECT p.fetched_at, ${bodyExpr("p", "p")} AS body FROM raw_payload p WHERE p.object_type = 'athlete_stats') p,
            (SELECT * FROM (VALUES ('recent'), ('ytd'), ('all')) a(period), (VALUES ('ride'), ('run'), ('swim')) s(sport)) t) src`,
      ),
    ],
    shapes: [
      {
        objects: objects("athlete_stats"),
        known: new Set([
          "biggest_ride_distance", "biggest_climb_elevation_gain",
          ...["recent", "ytd", "all"].flatMap((p) => ["ride", "run", "swim"].map((s) => `${p}_${s}_totals`)),
        ]),
      },
      { objects: `SELECT json_extract(body, '$.recent_run_totals') AS o FROM ${liveBodies("athlete_stats")} WHERE body IS NOT NULL`, known: known(athleteStats) },
    ],
  },
  {
    type: "gear",
    statements: [insert(gear, `(SELECT r.fetched_at, r.checked_at AS detail_fetched_at, r.body AS b FROM ${current("gear")}) src`)],
    shapes: [{ objects: objects("gear"), known: known(gear) }],
  },
  {
    type: "segment",
    statements: [insert(segment, `(SELECT r.fetched_at, r.checked_at AS detail_fetched_at, r.body AS b FROM ${current("segment")}) src`)],
    shapes: [{ objects: objects("segment"), known: known(segment) }],
  },
  {
    // The starred list (key 'self'): star flags for listed segments, unstar the rest.
    type: "segment_starred",
    statements: [
      upsert(
        segment,
        `(SELECT r.fetched_at, NULL::TIMESTAMPTZ AS detail_fetched_at, unnest(CAST(r.body AS JSON[])) AS b FROM ${current("segment_starred")}) src`,
        (c) => segmentSummary(c) || ["starred_date", "pr_time", "athlete_pr_effort"].includes(c.name),
      ),
      `UPDATE segment SET starred = false, starred_date = NULL
        WHERE starred AND id NOT IN (
          SELECT TRY_CAST(o->>'id' AS BIGINT) FROM (SELECT unnest(CAST(body AS JSON[])) AS o FROM ${liveBodies("segment_starred")} WHERE body IS NOT NULL))`,
    ],
    shapes: [{ objects: objects("segment_starred", "$[*]"), known: known(segment) }],
  },
  {
    type: "segment_streams",
    statements: [
      `DELETE FROM segment_stream_point WHERE segment_id IN ${activityIds}`,
      insert(segmentPoint, streamPoints("segment_streams", "segment_id", ["distance", "latlng", "altitude"])),
    ],
    shapes: [{ objects: objects("segment_streams"), known: new Set(["distance", "latlng", "altitude"]) }],
  },
  {
    type: "segment_effort",
    statements: [insert(effort, `(SELECT r.fetched_at, r.body AS b FROM ${current("segment_effort")}) src`)],
    shapes: [{ objects: objects("segment_effort"), known: known(effort) }],
  },
  {
    type: "segment_effort_streams",
    statements: [
      `DELETE FROM segment_effort_stream_point WHERE effort_id IN ${activityIds}`,
      insert(effortPoint, streamPoints("segment_effort_streams", "effort_id", Object.keys(STREAM_CASTS))),
    ],
    shapes: [{ objects: objects("segment_effort_streams"), known: new Set(Object.keys(STREAM_CASTS)) }],
  },
  {
    // The route list (key 'self'): summary columns, and routes no longer listed are removed.
    type: "route_list",
    statements: [
      upsert(route, `(SELECT r.fetched_at, NULL::TIMESTAMPTZ AS detail_fetched_at, unnest(CAST(r.body AS JSON[])) AS b FROM ${current("route_list")}) src`, routeSummary),
      `DELETE FROM route WHERE id NOT IN (
          SELECT TRY_CAST(o->>'id' AS BIGINT) FROM (SELECT unnest(CAST(body AS JSON[])) AS o FROM ${liveBodies("route_list")} WHERE body IS NOT NULL))`,
    ],
    shapes: [{ objects: objects("route_list", "$[*]"), known: known(route) }],
  },
  {
    type: "route",
    statements: [insert(route, `(SELECT r.fetched_at, r.checked_at AS detail_fetched_at, r.body AS b FROM ${current("route")}) src`)],
    shapes: [{ objects: objects("route"), known: known(route) }],
  },
  {
    // Route streams come as an array of {type, data}, not keyed by type.
    type: "route_streams",
    statements: [
      `DELETE FROM route_point WHERE route_id IN ${activityIds}`,
      insert(
        routePoint,
        streamPoints(
          "route_streams",
          "route_id",
          ["distance", "latlng", "altitude"],
          (k) => `(list_filter(CAST(r.body AS JSON[]), x -> (x->>'type') = '${k}')[1])->'data'`,
        ),
      ),
    ],
    shapes: [{ objects: objects("route_streams", "$[*]"), known: new Set(["type", "data", "series_type", "original_size", "resolution"]) }],
  },
  {
    type: "club_list",
    statements: [upsert(club, `(SELECT r.fetched_at, NULL::TIMESTAMPTZ AS detail_fetched_at, unnest(CAST(r.body AS JSON[])) AS b FROM ${current("club_list")}) src`, clubSummary)],
    shapes: [{ objects: objects("club_list", "$[*]"), known: known(club) }],
  },
  {
    type: "club",
    statements: [insert(club, `(SELECT r.fetched_at, r.checked_at AS detail_fetched_at, r.body AS b FROM ${current("club")}) src`)],
    shapes: [{ objects: objects("club"), known: known(club) }],
  },
];

export const PROJECTION_BY_TYPE = new Map(PROJECTIONS.map((p) => [p.type, p]));

/** Rebuild the typed rows for `keys` of `type` (all keys when null). */
export async function project(tx: Tx, type: string, keys: string[] | null): Promise<void> {
  const projection = PROJECTION_BY_TYPE.get(type);
  if (!projection) return;
  await tx.run("CREATE OR REPLACE TEMP TABLE _scope (object_key VARCHAR)");
  if (keys === null) {
    await tx.run("INSERT INTO _scope SELECT object_key FROM raw_latest WHERE object_type = $1", [type]);
  } else if (keys.length > 0) {
    await tx.run("INSERT INTO _scope SELECT unnest($1::VARCHAR[])", [listValue(keys)]);
  }
  for (const sql of projection.statements) await tx.run(sql);
}


/** Keys present in landed payloads that no projection maps: schema drift to look at. */
export async function drift(tx: Tx): Promise<Array<{ type: string; key: string; example_count: number }>> {
  const out: Array<{ type: string; key: string; example_count: number }> = [];
  for (const p of PROJECTIONS) {
    for (const shape of p.shapes) {
      const keys = shape.keys ?? `SELECT unnest(json_keys(o)) AS k FROM (${shape.objects}) WHERE o IS NOT NULL AND json_type(o) = 'OBJECT'`;
      const rows = await tx.all<{ k: string; n: number }>(`SELECT k, count(*)::INTEGER AS n FROM (${keys}) GROUP BY k`);
      for (const r of rows) if (!shape.known.has(r.k)) out.push({ type: p.type, key: r.k, example_count: r.n });
    }
  }
  return out;
}
