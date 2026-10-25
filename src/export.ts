/**
 * GET /export/sync (alias /export/garmin-sync): a small JSON payload for other
 * services that act on what this mirror knows. Read live from the mirror, so a
 * consumer does not have to wait for the next snapshot: the starred routes (with
 * their start point) and the activities that started since a given time. A few
 * kilobytes, no Strava request. Served to the snapshot's bearer token.
 *
 * garmin-mcp's optional Strava sync is the first consumer: it renames Garmin
 * activities after their Strava names and deletes the courses Strava made for
 * routes that are no longer starred. The contract is documented in
 * docs/reference/export.md; changing a field here is a breaking change there.
 */
import polyline from "@mapbox/polyline";
import type { Database } from "./db/database.js";

export interface ExportRoute {
  /** Route id as a string: route ids exceed 2^53 and would lose precision as a JSON number. */
  id: string;
  name: string;
  /** Meters, or null when Strava reported none. */
  distance: number | null;
  /** First point of the summary polyline, [lat, lng], or null without a polyline. */
  start: [number, number] | null;
}

export interface ExportActivity {
  /** Activity id as a string, for the same reason as routes. */
  id: string;
  name: string;
  /** Start in UTC, ISO 8601. */
  start_date: string;
  /** Seconds, or null when unknown. */
  elapsed_time: number | null;
}

export interface SyncExport {
  /** When this payload was computed. */
  generated_at: string;
  /** When the route list (and so the starred flags) was last fetched from Strava. */
  route_list_checked_at: string | null;
  /** When the recent activity list was last fetched (webhook events update names in between). */
  activity_list_checked_at: string | null;
  starred_routes: ExportRoute[];
  /** Activities not deleted on Strava that started at or after `since`; empty without `since`. */
  activities: ExportActivity[];
}

/**
 * The first [lat, lng] of a Google-encoded polyline, or null when there is none or
 * the string does not decode to a point on Earth (a corrupt or placeholder value).
 */
export function polylineStart(encoded: string | null | undefined): [number, number] | null {
  if (!encoded) return null;
  let first: [number, number] | undefined;
  try {
    first = polyline.decode(encoded)[0];
  } catch {
    return null;
  }
  if (!first || Math.abs(first[0]) > 90 || Math.abs(first[1]) > 180) return null;
  return [first[0], first[1]];
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export async function syncExport(db: Database, since: Date | null): Promise<SyncExport> {
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
