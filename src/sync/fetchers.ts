/**
 * Fetchers: one Strava request (or one paged listing) each, landed into the mirror.
 *
 * The sync worker and the cache-first tools call the same functions; only the
 * priority differs. A 404 is recorded (deleted activity, manual activity without
 * streams) rather than thrown, so it is never retried.
 */
import { listValue } from "@duckdb/node-api";
import type { Database } from "../db/database.js";
import { land, landMany, markNotFound } from "../db/raw.js";
import { StravaApiError } from "../errors.js";
import { requestRaw } from "../strava-client.js";
import type { Priority } from "./rate-limit.js";

export interface FetchResult {
  changed: boolean;
  notFound?: boolean;
}

export interface FetchOptions {
  priority: Priority;
  maxWaitMs?: number;
}

const ALL_STREAM_KEYS = "time,distance,latlng,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth";
const PAGE = 200;

/**
 * Split a JSON array's text into the raw text of each element, so each element can be
 * stored exactly as received (no re-serialization, no precision loss).
 */
export function splitArray(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (depth === 1 && start < 0) start = i;
    } else if (ch === "[" || ch === "{") {
      if (depth === 1 && start < 0) start = i;
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (start >= 0) out.push(text.slice(start, i).trim());
        start = -1;
      }
    } else if (ch === "," && depth === 1) {
      if (start >= 0) out.push(text.slice(start, i).trim());
      start = -1;
    } else if (depth === 1 && start < 0 && !/\s/.test(ch)) {
      start = i;
    }
  }
  return out;
}

/** Top-level "id" of a JSON object's text. */
export function topLevelId(objectText: string): string | null {
  // Ids precede nested objects in every Strava payload except where "athlete" or
  // "activity" comes first, so scan top-level keys properly.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < objectText.length; i++) {
    const ch = objectText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 1 && objectText.startsWith('"id"', i)) {
        const m = /^"id"\s*:\s*(\d+)/.exec(objectText.slice(i));
        if (m) return m[1]!;
      }
      inString = true;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return null;
}


export class Fetchers {
  constructor(private readonly db: Database) {}

  private async get(path: string, params: Record<string, unknown> | undefined, opts: FetchOptions): Promise<string | null> {
    try {
      const { text } = await requestRaw("GET", path, { params, priority: opts.priority, maxWaitMs: opts.maxWaitMs });
      return text;
    } catch (err) {
      if (err instanceof StravaApiError && err.statusCode === 404) return null;
      throw err;
    }
  }

  /** Fetch one object and land it under (type, key). */
  private async one(type: string, key: string, path: string, params: Record<string, unknown> | undefined, opts: FetchOptions): Promise<FetchResult> {
    const text = await this.get(path, params, opts);
    if (text === null) {
      await this.db.transaction((tx) => markNotFound(tx, type, key));
      return { changed: true, notFound: true };
    }
    const { changed } = await this.db.transaction((tx) => land(tx, type, key, text));
    return { changed };
  }

  /** Fetch every page of a list endpoint; returns the elements' raw text. */
  private async pages(path: string, params: Record<string, unknown>, opts: FetchOptions, pageParam = "page"): Promise<string[]> {
    const items: string[] = [];
    for (let page = 1; ; page++) {
      const text = await this.get(path, { ...params, per_page: PAGE, [pageParam]: page }, opts);
      if (text === null) break;
      const elements = splitArray(text);
      items.push(...elements);
      if (elements.length < PAGE) break;
    }
    return items;
  }

  /** Land a list as one payload (`type`, key 'self'), e.g. the starred segments. */
  private async list(type: string, path: string, params: Record<string, unknown>, opts: FetchOptions): Promise<FetchResult & { items: string[] }> {
    const items = await this.pages(path, params, opts);
    const body = `[${items.join(",")}]`;
    const { changed } = await this.db.transaction((tx) => land(tx, type, "self", body));
    return { changed, items };
  }

  athlete(opts: FetchOptions) {
    return this.one("athlete", "self", "/athlete", undefined, opts);
  }

  athleteZones(opts: FetchOptions) {
    return this.one("athlete_zones", "self", "/athlete/zones", undefined, opts);
  }

  /** The authenticated athlete's id, fetching the profile first if the mirror has none. */
  private async athleteId(opts: FetchOptions): Promise<string> {
    const read = () => this.db.one<{ id: string }>("SELECT id::VARCHAR AS id FROM athlete LIMIT 1");
    let row = await read();
    if (!row) {
      await this.athlete(opts);
      row = await read();
    }
    if (!row) throw new Error("Athlete profile unavailable");
    return row.id;
  }

  async athleteStats(opts: FetchOptions) {
    const id = await this.athleteId(opts);
    return this.one("athlete_stats", "self", `/athletes/${id}/stats`, undefined, opts);
  }

  /**
   * List activities (newest first), landing each summary. With `complete`, the caller
   * asked for the whole history, so activities missing from it are marked deleted.
   */
  async activities(
    opts: FetchOptions & { after?: number; before?: number; complete?: boolean },
  ): Promise<{ seen: string[]; changed: string[]; deleted: string[] }> {
    const params: Record<string, unknown> = {};
    if (opts.after !== undefined) params.after = opts.after;
    if (opts.before !== undefined) params.before = opts.before;
    const items = await this.pages("/athlete/activities", params, opts);
    const keyed = items.map((body) => ({ key: topLevelId(body)!, body })).filter((x) => x.key);
    const changed: string[] = [];
    for (let i = 0; i < keyed.length; i += PAGE) {
      const batch = keyed.slice(i, i + PAGE);
      changed.push(...(await this.db.transaction((tx) => landMany(tx, "activity_summary", batch))));
    }
    const seen = keyed.map((x) => x.key);
    let deleted: string[] = [];
    if (opts.complete) {
      deleted = await this.db.transaction(async (tx) => {
        const gone = await tx.all<{ k: string }>(
          `SELECT object_key AS k FROM raw_latest
           WHERE object_type = 'activity_summary' AND status = 'ok' AND object_key NOT IN (SELECT unnest($1::VARCHAR[]))`,
          [listValue(seen)],
        );
        for (const g of gone) await markNotFound(tx, "activity_summary", g.k);
        return gone.map((g) => g.k);
      });
    }
    return { seen, changed, deleted };
  }

  activityDetail(id: string, opts: FetchOptions) {
    return this.one("activity_detail", id, `/activities/${id}`, { include_all_efforts: true }, opts);
  }

  activityStreams(id: string, opts: FetchOptions) {
    return this.one("activity_streams", id, `/activities/${id}/streams`, { keys: ALL_STREAM_KEYS, key_by_type: true }, opts);
  }

  activityZones(id: string, opts: FetchOptions) {
    return this.one("activity_zones", id, `/activities/${id}/zones`, undefined, opts);
  }

  async activityKudos(id: string, opts: FetchOptions) {
    const items = await this.pages(`/activities/${id}/kudos`, {}, opts);
    return this.db.transaction((tx) => land(tx, "activity_kudos", id, `[${items.join(",")}]`));
  }

  async activityComments(id: string, opts: FetchOptions) {
    // Comments page by cursor; 200 per page covers any real activity in one request.
    const text = await this.get(`/activities/${id}/comments`, { page_size: PAGE }, opts);
    if (text === null) {
      await this.db.transaction((tx) => markNotFound(tx, "activity_comments", id));
      return { changed: true, notFound: true };
    }
    return this.db.transaction((tx) => land(tx, "activity_comments", id, text));
  }

  activityPhotos(id: string, opts: FetchOptions) {
    return this.one("activity_photos", id, `/activities/${id}/photos`, { size: 5000, photo_sources: true }, opts);
  }

  gear(id: string, opts: FetchOptions) {
    return this.one("gear", id, `/gear/${id}`, undefined, opts);
  }

  segment(id: string, opts: FetchOptions) {
    return this.one("segment", id, `/segments/${id}`, undefined, opts);
  }

  segmentStreams(id: string, opts: FetchOptions) {
    return this.one("segment_streams", id, `/segments/${id}/streams`, { keys: "distance,latlng,altitude", key_by_type: true }, opts);
  }

  starredSegments(opts: FetchOptions) {
    return this.list("segment_starred", "/segments/starred", {}, opts);
  }

  /** Efforts on a segment (subscription feature); each is landed individually. */
  async segmentEfforts(segmentId: string, range: { start?: string; end?: string }, opts: FetchOptions): Promise<string[]> {
    const params: Record<string, unknown> = { segment_id: segmentId };
    if (range.start) params.start_date_local = range.start;
    if (range.end) params.end_date_local = range.end;
    const items = await this.pages("/segment_efforts", params, opts);
    const keyed = items.map((body) => ({ key: topLevelId(body)!, body })).filter((x) => x.key);
    if (keyed.length) await this.db.transaction((tx) => landMany(tx, "segment_effort", keyed));
    return items;
  }

  segmentEffort(id: string, opts: FetchOptions) {
    return this.one("segment_effort", id, `/segment_efforts/${id}`, undefined, opts);
  }

  segmentEffortStreams(id: string, opts: FetchOptions) {
    return this.one("segment_effort_streams", id, `/segment_efforts/${id}/streams`, { keys: ALL_STREAM_KEYS, key_by_type: true }, opts);
  }

  async routes(opts: FetchOptions) {
    const id = await this.athleteId(opts);
    return this.list("route_list", `/athletes/${id}/routes`, {}, opts);
  }

  route(id: string, opts: FetchOptions) {
    return this.one("route", id, `/routes/${id}`, undefined, opts);
  }

  routeStreams(id: string, opts: FetchOptions) {
    return this.one("route_streams", id, `/routes/${id}/streams`, undefined, opts);
  }

  /** Route exports are XML; stored as a JSON string so they ride the same cache. */
  async routeExport(id: string, format: "gpx" | "tcx", opts: FetchOptions) {
    const text = await this.get(`/routes/${id}/export_${format}`, undefined, opts);
    const type = `route_${format}`;
    if (text === null) {
      await this.db.transaction((tx) => markNotFound(tx, type, id));
      return { changed: true, notFound: true };
    }
    return this.db.transaction((tx) => land(tx, type, id, JSON.stringify(text)));
  }

  clubs(opts: FetchOptions) {
    return this.list("club_list", "/athlete/clubs", {}, opts);
  }

  club(id: string, opts: FetchOptions) {
    return this.one("club", id, `/clubs/${id}`, undefined, opts);
  }
}
