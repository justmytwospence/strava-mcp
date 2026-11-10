/**
 * The canonical activity export (curves' schema v1): every activity's recorded stream in one Parquet file
 * (one row per whole second), plus a manifest, written from each published snapshot and served at
 * /export/canonical/v1/ with its own bearer (EXPORT_TOKEN). The exporter reads the snapshot through its own
 * in-memory DuckDB instance, because the live mirror's instance cannot write files.
 *
 * Power is exported only when it came from a power meter (Strava's estimate would pollute power curves); cadence
 * is written as Strava reports it (runs: one-leg steps per minute) with cadence_unit saying so.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { DuckDBInstance } from "@duckdb/node-api";

const SERVABLE = /^(manifest\.json|activities\/strava-\d+\.parquet)$/;

export function sportFromStrava(type: string, name = ""): string {
  switch (type.replace(/\s+/g, "").toLowerCase()) {
    case "run":
      return "run";
    case "trailrun":
      return "trail_run";
    case "virtualrun":
      return "treadmill_run";
    case "ride":
      return "ride";
    case "gravelride":
      return "gravel_ride";
    case "mountainbikeride":
      return "mountain_bike";
    case "virtualride":
      return "virtual_ride";
    case "walk":
      return "walk";
    case "hike":
      return "hike";
    case "backcountryski":
      return "backcountry_ski";
    case "nordicski":
      return /skate/i.test(name) ? "skate_ski" : "classic_ski";
    case "alpineski":
      return "resort_ski";
    case "swim":
      return "swim";
    case "rowing":
      return "row";
    case "kayaking":
    case "canoeing":
    case "standuppaddling":
      return "paddle";
    default:
      return "other";
  }
}

const FOOT = new Set(["run", "trail_run", "treadmill_run", "walk", "hike"]);
const WHEEL = new Set(["ride", "gravel_ride", "mountain_bike", "indoor_ride", "virtual_ride"]);
export const cadenceUnit = (sport: string): string | null =>
  FOOT.has(sport) ? "cycles" : WHEEL.has(sport) ? "rpm" : null;

interface Entry {
  id: string;
  updated_at: string;
  sha256: string;
  fingerprint: string;
  [k: string]: unknown;
}

const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The canonical tags of Strava's workout type: runs 1 race, 2 long run, 3 workout; rides 11 race, 12 workout. */
export function tagsOf(workoutType: unknown): string[] {
  const w = Number(workoutType);
  if (w === 1 || w === 11) return ["race"];
  if (w === 2) return ["long_run"];
  if (w === 3 || w === 12) return ["workout"];
  return [];
}

export class CanonicalExporter {
  constructor(
    readonly outDir: string,
    private readonly importer: string,
    private readonly opts = { memoryLimit: "256MB", batch: 200 },
  ) {}

  get manifestPath(): string {
    return join(this.outDir, "manifest.json");
  }

  async run(snapshotPath: string): Promise<{ activities: number; written: number; removed: number }> {
    const activitiesDir = join(this.outDir, "activities");
    mkdirSync(activitiesDir, { recursive: true });
    const base = dirname(this.outDir);
    const stage = join(base, "stage");
    const tmp = join(base, "tmp");
    mkdirSync(tmp, { recursive: true });
    const instance = await DuckDBInstance.create(":memory:");
    const con = await instance.connect();
    const rows = async <T>(sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
    const hashes = new Map<string, string>();
    let acts: Array<Record<string, string | number | boolean | null>>;
    const previous = new Map<string, Entry>();
    try {
      await con.run(`SET memory_limit = '${this.opts.memoryLimit}'`);
      await con.run("SET threads = 1");
      await con.run(`SET temp_directory = '${tmp}'`);
      await con.run("SET preserve_insertion_order = true");
      await con.run(`ATTACH '${snapshotPath.replace(/'/g, "''")}' AS s (READ_ONLY)`);
      acts = await rows(`
        WITH st AS (
          SELECT activity_id, count(*) AS records, count(DISTINCT time) AS n, min(time) AS t0
          FROM s.activity_stream_point WHERE time IS NOT NULL GROUP BY 1)
        SELECT a.id::VARCHAR AS id, st.n::INTEGER AS n, st.t0::BIGINT AS t0,
               st.records || '|strava-api/' || a.id || '-' || left(coalesce(r.content_hash, ''), 12) AS fingerprint,
               epoch_ms(a.start_date)::BIGINT AS start_ms, a.utc_offset, a.sport_type, a.type, a.name, a.device_name,
               coalesce(a.trainer, false) AS trainer, a.workout_type
        FROM s.activity a
        JOIN st ON st.activity_id = a.id
        JOIN s.raw_latest r ON r.object_type = 'activity_streams' AND r.object_key = a.id::VARCHAR AND r.status = 'ok'
        WHERE a.deleted_at IS NULL AND NOT coalesce(a.manual, false) AND st.n > 0
        ORDER BY a.start_date, a.id`);
      if (existsSync(this.manifestPath)) {
        for (const e of JSON.parse(readFileSync(this.manifestPath, "utf8")).activities as Entry[])
          previous.set(e.id, e);
      }
      const need: string[] = [];
      for (const a of acts) {
        const old = previous.get(`strava:${a.id}`);
        if (!old || old.fingerprint !== a.fingerprint || !existsSync(join(activitiesDir, `strava-${a.id}.parquet`)))
          need.push(String(a.id));
      }
      for (let i = 0; i < need.length; i += this.opts.batch) {
        const ids = need.slice(i, i + this.opts.batch);
        rmSync(stage, { recursive: true, force: true });
        await con.run(`
          COPY (
            WITH r AS (
              SELECT p.activity_id, p.time, p.lat, p.lng, p.altitude, p.distance, p.heartrate, p.watts, p.cadence, a.device_watts
              FROM s.activity_stream_point p JOIN s.activity a ON a.id = p.activity_id
              WHERE p.activity_id IN (${ids.join(", ")}) AND p.time IS NOT NULL
              QUALIFY row_number() OVER (PARTITION BY p.activity_id, p.time ORDER BY p.distance DESC NULLS LAST, p.idx) = 1)
            SELECT activity_id,
                   (time - min(time) OVER (PARTITION BY activity_id))::INTEGER AS t,
                   round(lat * 1e7)::INTEGER AS lat, round(lng * 1e7)::INTEGER AS lng,
                   altitude::DOUBLE AS alt, distance::DOUBLE AS dist, heartrate::FLOAT AS hr,
                   CASE WHEN coalesce(device_watts, false) THEN watts::FLOAT END AS power, cadence::FLOAT AS cadence
            FROM r ORDER BY activity_id, t)
          TO '${stage}' (FORMAT parquet, COMPRESSION snappy, PARTITION_BY (activity_id), OVERWRITE_OR_IGNORE)`);
        for (const id of ids) {
          const dir = join(stage, `activity_id=${id}`);
          const parts = readdirSync(dir).filter((f) => f.endsWith(".parquet"));
          if (parts.length !== 1)
            throw new Error(`export: expected one parquet file for activity ${id}, found ${parts.length}`);
          const dest = join(activitiesDir, `strava-${id}.parquet`);
          renameSync(join(dir, parts[0]!), dest);
          hashes.set(id, sha256(dest));
        }
      }
    } finally {
      con.closeSync();
      instance.closeSync();
      rmSync(stage, { recursive: true, force: true });
    }
    const now = iso(Date.now());
    const entries = acts.map((a) => {
      const id = String(a.id);
      const old = previous.get(`strava:${id}`);
      const type = String(a.sport_type ?? a.type ?? "");
      const sport = sportFromStrava(type, String(a.name ?? ""));
      return {
        id: `strava:${id}`,
        sources: [{ kind: "strava", id }],
        start_time: iso(Number(a.start_ms) + Number(a.t0) * 1000),
        utc_offset_min: Math.round(Number(a.utc_offset ?? 0) / 60),
        sport,
        source_sport: type || null,
        name: a.name ?? null,
        device: a.device_name ?? null,
        indoor: Boolean(a.trainer) || type === "VirtualRide" || type === "VirtualRun",
        manual: false,
        cadence_unit: cadenceUnit(sport),
        tags: tagsOf(a.workout_type),
        n: Number(a.n),
        sha256: hashes.get(id) ?? old?.sha256 ?? sha256(join(activitiesDir, `strava-${id}.parquet`)),
        fingerprint: String(a.fingerprint),
        updated_at: hashes.has(id) ? now : (old?.updated_at ?? now),
        file: `activities/strava-${id}.parquet`,
      };
    });
    const tmpManifest = `${this.manifestPath}.tmp`;
    writeFileSync(
      tmpManifest,
      JSON.stringify({ schema_version: 1, importer: this.importer, generated_at: now, activities: entries }, null, 1),
    );
    renameSync(tmpManifest, this.manifestPath);
    const keep = new Set(entries.map((e) => e.file.slice("activities/".length)));
    let removed = 0;
    for (const f of readdirSync(activitiesDir)) {
      if (f.endsWith(".parquet") && !keep.has(f)) {
        rmSync(join(activitiesDir, f));
        removed++;
      }
    }
    return { activities: entries.length, written: hashes.size, removed };
  }

  /** The manifest or one activity's file; 404 for anything else. */
  serve(rel: string): Response {
    const path = join(this.outDir, rel);
    if (!SERVABLE.test(rel) || !existsSync(path) || !statSync(path).isFile())
      return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        "content-type": rel === "manifest.json" ? "application/json" : "application/octet-stream",
        "content-length": String(statSync(path).size),
      },
    });
  }
}
