/**
 * Cache-first reads for the tools, resources and prompts.
 *
 * Every read is answered from the DuckDB mirror when the stored copy is fresh enough
 * for that kind of data, and fetched (interactive priority, landed into the mirror)
 * otherwise. If Strava cannot be asked right now (rate limit, outage) and a copy
 * exists, the copy is served and marked stale. Each answer says where it came from.
 */
import type { Database } from "./db/database.js";
import { land } from "./db/raw.js";
import { StravaApiError } from "./errors.js";
import { RateLimitWaitError, requestRaw, safeJsonParse } from "./strava-client.js";
import type { SyncEngine } from "./sync/engine.js";
import type { FetchOptions, FetchResult } from "./sync/fetchers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FOREVER = Number.POSITIVE_INFINITY;
/** How long a tool waits for the rate limiter before falling back to a stale copy. */
const INTERACTIVE_WAIT_MS = 20_000;

export interface Provenance {
  source: "mirror" | "strava";
  fetched_at: string | null;
  stale?: string;
}

export interface Cached<T = unknown> {
  data: T;
  meta: Provenance;
}

interface Stored {
  status: string;
  checked_ms: number;
  body: string | null;
}

function canServeStale(err: unknown): boolean {
  if (err instanceof RateLimitWaitError) return true;
  if (err instanceof StravaApiError) return err.statusCode === 429 || err.statusCode >= 500;
  return err instanceof TypeError; // fetch network failure
}

export class Mirror {
  private readonly opts: FetchOptions = { priority: "interactive", maxWaitMs: INTERACTIVE_WAIT_MS };

  constructor(
    readonly db: Database,
    readonly engine: SyncEngine,
  ) {}

  private get f() {
    return this.engine.fetch;
  }

  private async stored(type: string, key: string): Promise<Stored | undefined> {
    return this.db.one<Stored>(
      `SELECT status, epoch_ms(checked_at)::DOUBLE AS checked_ms, body FROM raw_current WHERE object_type = $1 AND object_key = $2`,
      [type, key],
    );
  }

  private toCached(s: Stored, source: Provenance["source"], stale?: string): Cached {
    if (s.status === "not_found" || s.body === null) {
      throw new StravaApiError(404, `Not found on Strava (as of ${new Date(s.checked_ms).toISOString()}).`);
    }
    const meta: Provenance = { source, fetched_at: new Date(s.checked_ms).toISOString() };
    if (stale) meta.stale = stale;
    return { data: safeJsonParse(s.body), meta };
  }

  /** Serve (type, key) from the mirror if younger than maxAgeMs, else fetch it first. */
  async cached(type: string, key: string, maxAgeMs: number, fetch: () => Promise<FetchResult | unknown>): Promise<Cached> {
    const before = await this.stored(type, key);
    if (before && Date.now() - before.checked_ms <= maxAgeMs) return this.toCached(before, "mirror");
    try {
      await fetch();
    } catch (err) {
      if (before && canServeStale(err)) return this.toCached(before, "mirror", (err as Error).message);
      throw err;
    }
    const after = await this.stored(type, key);
    if (!after) throw new Error(`Fetched ${type} ${key} but nothing was stored`);
    return this.toCached(after, "strava");
  }

  // ---------------------------------------------------------------- athlete

  athlete() {
    return this.cached("athlete", "self", 6 * HOUR, () => this.f.athlete(this.opts));
  }

  athleteZones() {
    return this.cached("athlete_zones", "self", DAY, () => this.f.athleteZones(this.opts));
  }

  athleteStats() {
    return this.cached("athlete_stats", "self", HOUR, () => this.f.athleteStats(this.opts));
  }

  // ---------------------------------------------------------------- activities

  /** Make sure the activity list includes anything uploaded in the last 15 minutes. */
  private async freshList(): Promise<Provenance> {
    const last = await this.db.one<{ value: string }>("SELECT value FROM sync_state WHERE name = 'last:list_recent'");
    const lastMs = last ? Date.parse(last.value) : 0;
    if (Date.now() - lastMs <= 15 * MINUTE) return { source: "mirror", fetched_at: new Date(lastMs).toISOString() };
    try {
      await this.engine.run({ kind: "list_recent", key: "self" }, "interactive");
      return { source: "strava", fetched_at: new Date().toISOString() };
    } catch (err) {
      if (lastMs && canServeStale(err)) {
        return { source: "mirror", fetched_at: new Date(lastMs).toISOString(), stale: (err as Error).message };
      }
      throw err;
    }
  }

  async listActivities(q: { before?: number; after?: number; page: number; perPage: number }): Promise<Cached<unknown[]>> {
    const meta = await this.freshList();
    const rows = await this.db.all<{ body: string }>(
      `SELECT coalesce(s.body, d.body) AS body
       FROM activity a
       LEFT JOIN raw_current s ON s.object_type = 'activity_summary' AND s.object_key = a.id::VARCHAR
       LEFT JOIN raw_current d ON d.object_type = 'activity_detail' AND d.object_key = a.id::VARCHAR
       WHERE a.deleted_at IS NULL
         AND ($1::BIGINT IS NULL OR epoch(a.start_date) < $1)
         AND ($2::BIGINT IS NULL OR epoch(a.start_date) > $2)
       ORDER BY a.start_date DESC
       LIMIT $3 OFFSET $4`,
      [q.before ?? null, q.after ?? null, q.perPage, (q.page - 1) * q.perPage],
    );
    return { data: rows.map((r) => safeJsonParse(r.body)), meta };
  }

  /**
   * Activity detail. Recent activities change (titles, kudos, late edits), so they are
   * refreshed often; older ones only when their summary shows they changed.
   */
  async activity(id: string): Promise<Cached> {
    const row = await this.db.one<{ age_ms: number | null; summary_newer: boolean }>(
      `SELECT (epoch_ms(now()) - epoch_ms(a.start_date))::DOUBLE AS age_ms,
              coalesce(s.fetched_at > d.checked_at, false) AS summary_newer
       FROM activity a
       LEFT JOIN raw_latest s ON s.object_type = 'activity_summary' AND s.object_key = a.id::VARCHAR
       LEFT JOIN raw_latest d ON d.object_type = 'activity_detail' AND d.object_key = a.id::VARCHAR
       WHERE a.id = $1::BIGINT`,
      [id],
    );
    let maxAge = FOREVER;
    if (!row || row.summary_newer) maxAge = 0;
    else if (row.age_ms !== null && row.age_ms < 2 * DAY) maxAge = 15 * MINUTE;
    else if (row.age_ms !== null && row.age_ms < 14 * DAY) maxAge = 6 * HOUR;
    return this.cached("activity_detail", id, maxAge, () => this.f.activityDetail(id, this.opts));
  }

  activityStreams(id: string) {
    return this.cached("activity_streams", id, FOREVER, () => this.f.activityStreams(id, this.opts));
  }

  activityZones(id: string) {
    return this.cached("activity_zones", id, FOREVER, () => this.f.activityZones(id, this.opts));
  }

  /** Kudos, comments, photos: refreshed when the activity's count disagrees, or hourly for a week. */
  private async social(type: string, countColumn: string, id: string, fetch: () => Promise<unknown>): Promise<Cached> {
    const row = await this.db.one<{ mismatch: boolean; recent: boolean }>(
      `SELECT coalesce(json_array_length(r.body) <> a.${countColumn}, true) AS mismatch,
              a.start_date > now() - INTERVAL 7 DAY AS recent
       FROM activity a LEFT JOIN raw_current r ON r.object_type = $2 AND r.object_key = a.id::VARCHAR
       WHERE a.id = $1::BIGINT`,
      [id, type],
    );
    const maxAge = !row || row.mismatch ? 0 : row.recent ? HOUR : FOREVER;
    return this.cached(type, id, maxAge, fetch);
  }

  activityKudos(id: string) {
    return this.social("activity_kudos", "kudos_count", id, () => this.f.activityKudos(id, this.opts));
  }

  activityComments(id: string) {
    return this.social("activity_comments", "comment_count", id, () => this.f.activityComments(id, this.opts));
  }

  activityPhotos(id: string) {
    return this.social("activity_photos", "total_photo_count", id, () => this.f.activityPhotos(id, this.opts));
  }

  // ---------------------------------------------------------------- gear, segments

  gear(id: string) {
    return this.cached("gear", id, DAY, () => this.f.gear(id, this.opts));
  }

  segment(id: string) {
    return this.cached("segment", id, 7 * DAY, () => this.f.segment(id, this.opts));
  }

  segmentStreams(id: string) {
    return this.cached("segment_streams", id, FOREVER, () => this.f.segmentStreams(id, this.opts));
  }

  starredSegments() {
    return this.cached("segment_starred", "self", HOUR, () => this.f.starredSegments(this.opts));
  }

  segmentEffort(id: string) {
    return this.cached("segment_effort", id, FOREVER, () => this.f.segmentEffort(id, this.opts));
  }

  segmentEffortStreams(id: string) {
    return this.cached("segment_effort_streams", id, FOREVER, () => this.f.segmentEffortStreams(id, this.opts));
  }

  /**
   * The athlete's efforts on a segment. Every activity detail carries all its efforts,
   * so once the detail backfill is complete the mirror has them all; until then ask Strava.
   */
  async segmentEfforts(segmentId: string, range: { start?: string; end?: string }, perPage: number): Promise<Cached<unknown[]>> {
    const pending = await this.db.one<{ n: number }>(
      "SELECT count(*)::INTEGER AS n FROM sync_job WHERE kind = 'activity_detail'",
    );
    const hasActivities = await this.db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM activity");
    if (pending?.n === 0 && (hasActivities?.n ?? 0) > 0) {
      const rows = await this.db.all<{ effort: string }>(
        `SELECT e.effort::VARCHAR AS effort FROM (
           SELECT unnest(CAST(json_extract(d.body, '$.segment_efforts') AS JSON[])) AS effort
           FROM activity a JOIN raw_current d ON d.object_type = 'activity_detail' AND d.object_key = a.id::VARCHAR
           WHERE a.deleted_at IS NULL) e
         WHERE TRY_CAST(e.effort->'segment'->>'id' AS BIGINT) = $1::BIGINT
           AND ($2::VARCHAR IS NULL OR (e.effort->>'start_date_local') >= $2)
           AND ($3::VARCHAR IS NULL OR (e.effort->>'start_date_local') <= $3)
         ORDER BY e.effort->>'start_date_local' DESC LIMIT $4`,
        [segmentId, range.start ?? null, range.end ?? null, perPage],
      );
      return { data: rows.map((r) => safeJsonParse(r.effort)), meta: { source: "mirror", fetched_at: null } };
    }
    const items = await this.f.segmentEfforts(segmentId, range, this.opts);
    return {
      data: items.slice(0, perPage).map((t) => safeJsonParse(t)),
      meta: { source: "strava", fetched_at: new Date().toISOString() },
    };
  }

  // ---------------------------------------------------------------- routes, clubs

  routes() {
    return this.cached("route_list", "self", HOUR, () => this.f.routes(this.opts));
  }

  /** A route is refreshed when the route list reports it updated since it was fetched. */
  private async routeAge(type: string, id: string): Promise<number> {
    const row = await this.db.one<{ newer: boolean }>(
      `SELECT coalesce(r.updated_at > l.checked_at, true) AS newer FROM route r
       LEFT JOIN raw_latest l ON l.object_type = $2 AND l.object_key = r.id::VARCHAR WHERE r.id = $1::BIGINT`,
      [id, type],
    );
    return row?.newer === false ? DAY : 0;
  }

  async route(id: string) {
    return this.cached("route", id, await this.routeAge("route", id), () => this.f.route(id, this.opts));
  }

  async routeStreams(id: string) {
    return this.cached("route_streams", id, await this.routeAge("route_streams", id), () => this.f.routeStreams(id, this.opts));
  }

  async routeExport(id: string, format: "gpx" | "tcx") {
    return this.cached(`route_${format}`, id, await this.routeAge(`route_${format}`, id), () =>
      this.f.routeExport(id, format, this.opts),
    );
  }

  clubs() {
    return this.cached("club_list", "self", DAY, () => this.f.clubs(this.opts));
  }

  club(id: string) {
    return this.cached("club", id, DAY, () => this.f.club(id, this.opts));
  }

  // ---------------------------------------------------------------- writes

  /**
   * Send a write to Strava and land what it returns (as `landAs`), so the mirror
   * reflects the write immediately and never holds optimistic state.
   */
  async write(
    method: "POST" | "PUT",
    path: string,
    body: Record<string, unknown> | FormData,
    landAs?: { type: string; key?: (parsed: Record<string, unknown>) => string },
  ): Promise<unknown> {
    const { text, contentType } = await requestRaw(method, path, { body, priority: "interactive", maxWaitMs: INTERACTIVE_WAIT_MS });
    const parsed = contentType.includes("application/json") ? (safeJsonParse(text) as Record<string, unknown>) : text;
    if (landAs && typeof parsed === "object" && parsed !== null) {
      const key = landAs.key ? landAs.key(parsed) : String(parsed.id);
      await this.db.transaction((tx) => land(tx, landAs.type, key, text));
    }
    return parsed;
  }
}
