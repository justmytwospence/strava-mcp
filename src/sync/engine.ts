/**
 * The sync engine: a durable job queue in the mirror, a single worker that drains it
 * within the rate limits, a planner that turns gaps in the mirror into jobs, and a
 * scheduler for the periodic listings.
 *
 * Priorities (lower runs first):
 *    5  on-demand refreshes queued by tools
 *   10  incremental: new activities and anything from the last week
 *   15  periodic: profile, zones, stats, routes, clubs, starred segments
 *   20  backfill core: activity details and streams, newest first
 *   21  backfill zones
 *   25  gear details, route details, the weekly full listing
 *   26  route geometry
 *   30  social: kudos, comments, photos
 *   35  club details
 *   40  segment details
 *   41  segment geometry
 * Priorities below 10 use the interactive rate class, below 20 incremental, the rest
 * backfill.
 */
import type { Database } from "../db/database.js";
import { StravaApiError } from "../errors.js";
import { limiter, RateLimitWaitError } from "../strava-client.js";
import { DAY, HOUR, MINUTE, SECOND } from "../time.js";
import { Fetchers } from "./fetchers.js";
import type { Priority } from "./rate-limit.js";

/** The activity-list poll interval while a webhook subscription is active. */
const PUSH_LIST_RECENT_EVERY = 6 * HOUR;

/**
 * How often the route list is refreshed. Strava sends no webhook for starring or
 * unstarring a route, so polling is the only way to notice; each poll costs one or two
 * reads. The default is an hour; STRAVA_ROUTES_INTERVAL_MINUTES lowers it (to no less
 * than five minutes) when something consumes the starred flag promptly, such as
 * garmin-mcp's course cleanup through /export/sync.
 */
export const DEFAULT_ROUTES_INTERVAL_MINUTES = 60;
export const MIN_ROUTES_INTERVAL_MINUTES = 5;

export function routesInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STRAVA_ROUTES_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw === "" ? DEFAULT_ROUTES_INTERVAL_MINUTES : Number(raw);
  if (!Number.isFinite(minutes)) {
    throw new Error(`STRAVA_ROUTES_INTERVAL_MINUTES must be a number of minutes, got "${raw}"`);
  }
  return Math.max(MIN_ROUTES_INTERVAL_MINUTES, minutes) * MINUTE;
}

export function priorityClass(priority: number): Priority {
  if (priority < 10) return "interactive";
  if (priority < 20) return "incremental";
  return "backfill";
}

interface Job {
  kind: string;
  key: string;
  priority: number;
  attempts: number;
}

/** Periodic tasks: kind, interval, priority. */
const PERIODIC: Array<{ kind: string; every: number; priority: number }> = [
  // With a live push subscription, Strava tells us about new activities, and the
  // listing only runs as a safety net (see PUSH_LIST_RECENT_EVERY).
  { kind: "list_recent", every: 15 * MINUTE, priority: 10 },
  { kind: "athlete", every: 6 * HOUR, priority: 15 },
  { kind: "athlete_stats", every: 6 * HOUR, priority: 15 },
  { kind: "athlete_zones", every: DAY, priority: 15 },
  { kind: "list_window", every: DAY, priority: 15 },
  { kind: "starred_segments", every: DAY, priority: 15 },
  // See routesInterval(): the interval is read from the environment at schedule time.
  { kind: "routes", every: DEFAULT_ROUTES_INTERVAL_MINUTES * MINUTE, priority: 15 },
  { kind: "clubs", every: DAY, priority: 15 },
  { kind: "list_full", every: 7 * DAY, priority: 25 },
];

/**
 * Gaps in the mirror, as jobs. Each query yields (kind, key, priority, sort_key);
 * recent activities (last 7 days) are promoted to incremental priority.
 */
const RECENT = "a.start_date > now() - INTERVAL 7 DAY";
const PLAN: string[] = [
  // Detail: never fetched, or the summary changed since (edit, new kudos count, ...).
  `SELECT 'activity_detail', a.id::VARCHAR, CASE WHEN ${RECENT} THEN 10 ELSE 20 END, epoch(a.start_date)::BIGINT
   FROM activity a
   LEFT JOIN raw_latest d ON d.object_type = 'activity_detail' AND d.object_key = a.id::VARCHAR
   LEFT JOIN raw_latest s ON s.object_type = 'activity_summary' AND s.object_key = a.id::VARCHAR
   WHERE a.deleted_at IS NULL AND (d.object_key IS NULL OR (d.status = 'ok' AND s.fetched_at > d.checked_at))`,
  `SELECT 'activity_streams', a.id::VARCHAR, CASE WHEN ${RECENT} THEN 10 ELSE 20 END, epoch(a.start_date)::BIGINT
   FROM activity a
   WHERE a.deleted_at IS NULL AND NOT coalesce(a.manual, false)
     AND NOT EXISTS (SELECT 1 FROM raw_latest r WHERE r.object_type = 'activity_streams' AND r.object_key = a.id::VARCHAR)`,
  `SELECT 'activity_zones', a.id::VARCHAR, CASE WHEN ${RECENT} THEN 11 ELSE 21 END, epoch(a.start_date)::BIGINT
   FROM activity a
   WHERE a.deleted_at IS NULL AND (a.has_heartrate OR a.device_watts OR a.average_watts IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM raw_latest r WHERE r.object_type = 'activity_zones' AND r.object_key = a.id::VARCHAR)`,
  // Social: fetched when the count on the activity differs from what is stored.
  ...(
    [
      ["activity_kudos", "kudos_count"],
      ["activity_comments", "comment_count"],
      ["activity_photos", "total_photo_count"],
    ] as const
  ).map(
    ([type, count]) =>
      `SELECT '${type}', a.id::VARCHAR, CASE WHEN ${RECENT} THEN 12 ELSE 30 END, epoch(a.start_date)::BIGINT
       FROM activity a
       LEFT JOIN raw_current r ON r.object_type = '${type}' AND r.object_key = a.id::VARCHAR
       WHERE a.deleted_at IS NULL AND (
         (r.object_key IS NULL AND coalesce(a.${count}, 0) > 0)
         OR (r.status = 'ok' AND coalesce(json_array_length(r.body), 0) <> coalesce(a.${count}, 0)))`,
  ),
  `SELECT 'gear', g.id, 25, 0 FROM (
     SELECT DISTINCT gear_id AS id FROM activity WHERE gear_id IS NOT NULL AND gear_id <> 'none'
     UNION SELECT id FROM gear) g
   LEFT JOIN raw_latest r ON r.object_type = 'gear' AND r.object_key = g.id
   WHERE r.object_key IS NULL OR r.checked_at < now() - INTERVAL 7 DAY`,
  `SELECT 'route', r.id::VARCHAR, 25, 0 FROM route r
   LEFT JOIN raw_latest l ON l.object_type = 'route' AND l.object_key = r.id::VARCHAR
   WHERE l.object_key IS NULL OR r.updated_at > l.checked_at`,
  `SELECT 'route_streams', r.id::VARCHAR, 26, 0 FROM route r
   LEFT JOIN raw_latest l ON l.object_type = 'route_streams' AND l.object_key = r.id::VARCHAR
   WHERE l.object_key IS NULL OR r.updated_at > l.checked_at`,
  `SELECT 'club', c.id::VARCHAR, 35, 0 FROM club c
   WHERE NOT EXISTS (SELECT 1 FROM raw_latest r WHERE r.object_type = 'club' AND r.object_key = c.id::VARCHAR)`,
  `SELECT 'segment', s.id::VARCHAR, 40, 0 FROM segment s
   WHERE NOT EXISTS (SELECT 1 FROM raw_latest r WHERE r.object_type = 'segment' AND r.object_key = s.id::VARCHAR)`,
  `SELECT 'segment_streams', s.id::VARCHAR, 41, 0 FROM segment s
   WHERE NOT EXISTS (SELECT 1 FROM raw_latest r WHERE r.object_type = 'segment_streams' AND r.object_key = s.id::VARCHAR)`,
];

export interface EngineOptions {
  /** Called after a job changed the mirror (e.g. to schedule a snapshot). */
  onChange?: () => void;
  /** Ceiling on how long the worker waits for the rate limiter before re-picking a job. */
  pollMs?: number;
  /** Route list refresh interval; defaults to STRAVA_ROUTES_INTERVAL_MINUTES or an hour. */
  routesIntervalMs?: number;
}

export class SyncEngine {
  readonly fetch: Fetchers;
  private readonly routesEvery: number;
  private running = false;
  private wake: (() => void) | null = null;
  private current: Job | null = null;
  private stopped: Promise<void> | null = null;
  private pushActive = false;
  /** Status of the webhook subscription, for sync_status. */
  pushStatus: (() => Promise<unknown>) | null = null;

  constructor(
    private readonly db: Database,
    private readonly options: EngineOptions = {},
  ) {
    this.fetch = new Fetchers(db);
    this.routesEvery = options.routesIntervalMs ?? routesInterval();
  }

  /** Whether Strava pushes activity events to us, which makes frequent polling unnecessary. */
  setPushActive(active: boolean): void {
    this.pushActive = active;
  }

  async enqueue(kind: string, key: string, priority: number, sortKey = 0): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_job (kind, key, priority, sort_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, key) DO UPDATE SET priority = least(sync_job.priority, excluded.priority),
         not_before = CASE WHEN excluded.priority < sync_job.priority THEN now() ELSE sync_job.not_before END`,
      [kind, key, priority, sortKey],
    );
    this.wake?.();
  }

  /** Turn every gap in the mirror into a job. Costs no API calls. */
  async plan(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const before = (await tx.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM sync_job"))!.n;
      for (const sql of PLAN) {
        await tx.run(
          `INSERT INTO sync_job (kind, key, priority, sort_key)
           SELECT * FROM (${sql}) ON CONFLICT (kind, key) DO UPDATE SET priority = least(sync_job.priority, excluded.priority)`,
        );
      }
      const after = (await tx.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM sync_job"))!.n;
      return after - before;
    });
  }

  /** Queue the periodic tasks that are due. */
  async schedule(): Promise<void> {
    const state = new Map(
      (await this.db.all<{ name: string; value: string }>("SELECT name, value FROM sync_state")).map((r) => [
        r.name,
        r.value,
      ]),
    );
    const hasActivities = await this.db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM activity");
    for (const task of PERIODIC) {
      const last = state.get(`last:${task.kind}`);
      let every = task.every;
      if (task.kind === "list_recent" && this.pushActive) every = PUSH_LIST_RECENT_EVERY;
      if (task.kind === "routes") every = this.routesEvery;
      if (last && Date.now() - Date.parse(last) < every) continue;
      // The first full listing is the start of the backfill, so it runs at incremental priority.
      const priority = task.kind === "list_full" && !hasActivities?.n ? 10 : task.priority;
      await this.enqueue(task.kind, "self", priority);
    }
  }

  private async markRan(kind: string): Promise<void> {
    await this.db.run("INSERT OR REPLACE INTO sync_state (name, value, updated_at) VALUES ($1, $2, now())", [
      `last:${kind}`,
      new Date().toISOString(),
    ]);
  }

  private async nextJob(): Promise<Job | undefined> {
    return this.db.one<Job>(
      `SELECT kind, key, priority, attempts FROM sync_job
       WHERE not_before <= now()
       ORDER BY priority, sort_key DESC, created_at LIMIT 1`,
    );
  }

  /** Run one job. Returns whether it changed the mirror. */
  async run(job: Pick<Job, "kind" | "key">, priority: Priority): Promise<boolean> {
    const o = { priority };
    const f = this.fetch;
    const k = job.key;
    switch (job.kind) {
      case "list_recent": {
        // Newest stored start minus two days, to catch late uploads and fresh edits.
        const row = await this.db.one<{ t: number | null }>(
          "SELECT (epoch(max(start_date)) - 2 * 86400)::BIGINT AS t FROM activity WHERE deleted_at IS NULL",
        );
        const first = !row?.t;
        const r = await f.activities({ ...o, after: first ? undefined : Number(row!.t), complete: first });
        await this.markRan(job.kind);
        // The very first listing is complete, so the weekly full listing is not due yet.
        if (first) {
          await this.markRan("list_full");
          await this.db.run("DELETE FROM sync_job WHERE kind = 'list_full'");
        }
        await this.plan();
        return r.changed.length > 0;
      }
      case "list_window": {
        const r = await f.activities({ ...o, after: Math.floor((Date.now() - 90 * DAY) / 1000) });
        await this.markRan(job.kind);
        await this.plan();
        return r.changed.length > 0;
      }
      case "list_full": {
        const r = await f.activities({ ...o, complete: true });
        await this.markRan(job.kind);
        await this.plan();
        return r.changed.length + r.deleted.length > 0;
      }
      case "athlete":
      case "athlete_zones":
      case "athlete_stats":
      case "starred_segments":
      case "routes":
      case "clubs": {
        const method = {
          athlete: () => f.athlete(o),
          athlete_zones: () => f.athleteZones(o),
          athlete_stats: () => f.athleteStats(o),
          starred_segments: () => f.starredSegments(o),
          routes: () => f.routes(o),
          clubs: () => f.clubs(o),
        }[job.kind]!;
        const r = await method();
        await this.markRan(job.kind);
        if (r.changed) await this.plan();
        return r.changed;
      }
      case "activity_detail": {
        const r = await f.activityDetail(k, o);
        if (r.changed) await this.plan();
        return r.changed;
      }
      case "activity_streams":
        return (await f.activityStreams(k, o)).changed;
      case "activity_zones":
        return (await f.activityZones(k, o)).changed;
      case "activity_kudos":
        return (await f.activityKudos(k, o)).changed;
      case "activity_comments":
        return (await f.activityComments(k, o)).changed;
      case "activity_photos":
        return (await f.activityPhotos(k, o)).changed;
      case "gear":
        return (await f.gear(k, o)).changed;
      case "route":
        return (await f.route(k, o)).changed;
      case "route_streams":
        return (await f.routeStreams(k, o)).changed;
      case "club":
        return (await f.club(k, o)).changed;
      case "segment":
        return (await f.segment(k, o)).changed;
      case "segment_streams":
        return (await f.segmentStreams(k, o)).changed;
      default:
        throw new Error(`Unknown job kind ${job.kind}`);
    }
  }

  private async log(job: Job, outcome: string, detail?: string): Promise<void> {
    await this.db.run("INSERT INTO sync_log (kind, key, outcome, detail) VALUES ($1, $2, $3, $4)", [
      job.kind,
      job.key,
      outcome,
      detail ?? null,
    ]);
  }

  private async step(): Promise<"worked" | "idle" | "waiting"> {
    const job = await this.nextJob();
    if (!job) return "idle";
    const cls = priorityClass(job.priority);
    // Wait for the limiter, but not so long that a more urgent job could not jump in.
    const delay = limiter.delayFor(cls, "GET", jobPath(job));
    if (delay > 0) {
      await this.sleep(Math.min(delay, this.options.pollMs ?? 30 * SECOND));
      return "waiting";
    }
    this.current = job;
    try {
      const changed = await this.run(job, cls);
      await this.db.run("DELETE FROM sync_job WHERE kind = $1 AND key = $2", [job.kind, job.key]);
      await this.log(job, changed ? "changed" : "ok");
      if (changed) this.options.onChange?.();
    } catch (err) {
      if (err instanceof RateLimitWaitError || (err instanceof StravaApiError && err.statusCode === 429)) {
        await this.log(job, "rate_limited", (err as Error).message.slice(0, 500));
        return "waiting";
      }
      const attempts = job.attempts + 1;
      const backoffMin = Math.min(2 ** attempts, 24 * 60);
      await this.db.run(
        `UPDATE sync_job SET attempts = $3, last_error = $4, not_before = now() + to_minutes($5::BIGINT)
         WHERE kind = $1 AND key = $2`,
        [job.kind, job.key, attempts, (err as Error).message.slice(0, 1000), backoffMin],
      );
      await this.log(job, "error", (err as Error).message.slice(0, 1000));
      console.error(`sync: ${job.kind} ${job.key} failed (attempt ${attempts}):`, (err as Error).message);
    } finally {
      this.current = null;
    }
    return "worked";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  /** Start the worker loop and the scheduler. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = (async () => {
      let lastSchedule = 0;
      let lastPlan = 0;
      let lastPrune = 0;
      while (this.running) {
        try {
          if (Date.now() - lastSchedule > MINUTE) {
            await this.schedule();
            lastSchedule = Date.now();
          }
          if (Date.now() - lastPlan > HOUR) {
            await this.plan();
            lastPlan = Date.now();
          }
          if (Date.now() - lastPrune > DAY) {
            await this.db.run("DELETE FROM rate_sample WHERE observed_at < now() - INTERVAL 30 DAY");
            await this.db.run("DELETE FROM sync_log WHERE logged_at < now() - INTERVAL 30 DAY");
            lastPrune = Date.now();
          }
          const result = await this.step();
          if (result === "idle") await this.sleep(MINUTE);
        } catch (err) {
          console.error("sync: worker error:", err);
          await this.sleep(MINUTE);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.stopped;
  }

  async status(): Promise<Record<string, unknown>> {
    const queue = await this.db.all(
      `SELECT kind, count(*)::INTEGER AS pending, min(priority)::INTEGER AS top_priority,
         count(*) FILTER (WHERE attempts > 0)::INTEGER AS retrying,
         any_value(last_error) FILTER (WHERE last_error IS NOT NULL) AS example_error
       FROM sync_job GROUP BY kind ORDER BY min(priority), kind`,
    );
    const lastRuns = await this.db.all("SELECT name, value FROM sync_state ORDER BY name");
    const recent = await this.db.all(
      `SELECT outcome, count(*)::INTEGER AS n FROM sync_log WHERE logged_at > now() - INTERVAL 1 DAY GROUP BY outcome ORDER BY outcome`,
    );
    const errors = await this.db.all(
      `SELECT logged_at, kind, key, detail FROM sync_log WHERE outcome = 'error' ORDER BY logged_at DESC LIMIT 5`,
    );
    const coverage = await this.db.one(
      `SELECT
         count(*) FILTER (WHERE deleted_at IS NULL)::INTEGER AS activities,
         count(*) FILTER (WHERE deleted_at IS NOT NULL)::INTEGER AS deleted,
         count(detail_fetched_at)::INTEGER AS with_detail,
         (SELECT count(*) FROM raw_latest WHERE object_type = 'activity_streams' AND status = 'ok')::INTEGER AS with_streams,
         (SELECT count(*) FROM raw_latest WHERE object_type = 'activity_zones')::INTEGER AS with_zones,
         min(start_date)::VARCHAR AS oldest, max(start_date)::VARCHAR AS newest
       FROM activity`,
    );
    return {
      working_on: this.current ? `${this.current.kind} ${this.current.key}` : null,
      coverage,
      queue,
      last_runs: Object.fromEntries(lastRuns.map((r) => [String(r.name).replace(/^last:/, ""), r.value])),
      outcomes_last_24h: recent,
      recent_errors: errors,
      rate_limits: limiter.status(),
      webhook: this.pushStatus ? await this.pushStatus() : null,
    };
  }
}

/** A representative path for rate-limit admission; missing headers never exempt a job. */
function jobPath(job: Pick<Job, "kind" | "key">): string {
  switch (job.kind) {
    case "activity_streams":
      return `/activities/${job.key}/streams`;
    case "activity_detail":
      return `/activities/${job.key}`;
    default:
      return `/${job.kind}`;
  }
}
