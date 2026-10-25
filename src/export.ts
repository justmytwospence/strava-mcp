/**
 * GET /export/garmin-sync: the few facts garmin-mcp's Strava sync needs, read live
 * from the mirror, so it does not have to wait for the hourly snapshot. Starred routes
 * (with their start point) and the names of activities that started since a given
 * time; a few kilobytes, no Strava request. Served to the snapshot's bearer token.
 */
import type { Database } from "./db/database.js";

export interface ExportRoute {
  /** Route id as a string: route ids exceed 2^53. */
  id: string;
  name: string;
  distance: number | null;
  /** First point of the summary polyline, [lat, lng]. */
  start: [number, number] | null;
}

export interface ExportActivity {
  id: string;
  name: string;
  start_date: string;
  elapsed_time: number | null;
}

export interface GarminSyncExport {
  generated_at: string;
  /** When the route list (and so the starred flags) was last fetched from Strava. */
  route_list_checked_at: string | null;
  /** When the recent activity list was last fetched (webhook events update names in between). */
  activity_list_checked_at: string | null;
  starred_routes: ExportRoute[];
  activities: ExportActivity[];
}

/** The first [lat, lng] of a Google-encoded polyline, decoding only two values. */
export function polylineStart(encoded: string | null | undefined): [number, number] | null {
  if (!encoded) return null;
  const values: number[] = [];
  let i = 0;
  while (values.length < 2) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= encoded.length) return null;
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  return [values[0]! / 1e5, values[1]! / 1e5];
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function garminSyncExport(db: Database, since: Date | null): Promise<GarminSyncExport> {
  const checked = await db.one<{ t: string | null }>(
    "SELECT checked_at::VARCHAR AS t FROM raw_latest WHERE object_type = 'route_list' AND object_key = 'self'",
  );
  const listed = await db.one<{ value: string | null }>("SELECT value FROM sync_state WHERE name = 'last:list_recent'");
  const routes = await db.all<{ id: string; name: string | null; distance: number | null; polyline: string | null }>(
    "SELECT coalesce(id_str, id::VARCHAR) AS id, name, distance, summary_polyline AS polyline FROM route WHERE starred ORDER BY id",
  );
  const activities = since
    ? await db.all<{ id: string; name: string | null; start_date: string; elapsed_time: number | null }>(
        `SELECT id::VARCHAR AS id, name, start_date::VARCHAR AS start_date, elapsed_time FROM activity
          WHERE deleted_at IS NULL AND start_date >= $1::TIMESTAMPTZ ORDER BY start_date`,
        [since.toISOString()],
      )
    : [];
  return {
    generated_at: new Date().toISOString(),
    route_list_checked_at: iso(checked?.t),
    activity_list_checked_at: iso(listed?.value),
    starred_routes: routes.map((r) => ({
      id: String(r.id),
      name: r.name ?? "",
      distance: r.distance === null ? null : Number(r.distance),
      start: polylineStart(r.polyline),
    })),
    activities: activities.map((a) => ({
      id: String(a.id),
      name: a.name ?? "",
      start_date: iso(a.start_date) ?? String(a.start_date),
      elapsed_time: a.elapsed_time === null ? null : Number(a.elapsed_time),
    })),
  };
}
