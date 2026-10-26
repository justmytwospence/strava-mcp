import { mirror } from "../context.js";
import { provenanceText } from "../format.js";
import type { Cached } from "../mirror.js";
import { safeJsonParse } from "../strava-client.js";

/** Prompt retrieval never refreshes, queues work, or contacts Strava. */
export function localContext() {
  const db = mirror().db;
  const stored = async (type: string, id: string): Promise<Cached> => {
    const row = await db.one<{ body: string | null; checked_at: string; status: string }>(
      "SELECT body, checked_at::VARCHAR AS checked_at, status FROM raw_current WHERE object_type = $1 AND object_key = $2",
      [type, id],
    );
    if (!row?.body || row.status !== "ok")
      throw new Error(
        `No stored ${type} ${id}. Use the matching read tool to refresh it first; prompt retrieval never syncs.`,
      );
    return { data: safeJsonParse(row.body), meta: { source: "mirror", fetched_at: row.checked_at } };
  };
  return {
    athlete: () => stored("athlete", "self"),
    athleteStats: () => stored("athlete_stats", "self"),
    activity: (id: string) => stored("activity_detail", id),
    activityStreams: (id: string) => stored("activity_streams", id),
    segment: (id: string) => stored("segment", id),
    async listActivities(q: {
      after: number;
      before?: number;
      page: number;
      perPage: number;
    }): Promise<Cached<unknown[]>> {
      // Like the list tool, read small inline summaries; do not assemble every historical detail body.
      const rows = await db.all<{ id: string; body: string | null }>(
        `SELECT a.id::VARCHAR AS id, p.body FROM activity a
         LEFT JOIN raw_latest l ON l.object_type = 'activity_summary' AND l.object_key = a.id::VARCHAR
         LEFT JOIN raw_payload p USING (object_type, object_key, content_hash)
         WHERE a.deleted_at IS NULL AND epoch(a.start_date) >= $1 AND ($2::BIGINT IS NULL OR epoch(a.start_date) < $2)
         ORDER BY a.start_date DESC LIMIT $3`,
        [q.after, q.before ?? null, q.perPage + 1],
      );
      const data: unknown[] = [];
      for (const row of rows.slice(0, q.perPage)) {
        const body =
          row.body ??
          (
            await db.one<{ body: string | null }>(
              "SELECT body FROM raw_current WHERE object_type = 'activity_detail' AND object_key = $1",
              [row.id],
            )
          )?.body;
        if (body) data.push(safeJsonParse(body));
      }
      return {
        data,
        meta: {
          source: "mirror",
          fetched_at: null,
          truncated: rows.length > q.perPage,
          partial:
            "Stored activities only; backfill/refresh may be incomplete. Totals cover the returned window/page, not necessarily all training.",
        },
      };
    },
    async segmentEfforts(id: string, _range: object, limit: number): Promise<Cached<unknown[]>> {
      const rows = await db.all<{ achievements: string }>(
        `SELECT e.id, strftime(e.start_date_local, '%Y-%m-%dT%H:%M:%SZ') AS start_date_local,
                e.elapsed_time, e.average_heartrate, e.max_heartrate, e.average_watts, e.pr_rank,
                coalesce(e.achievements::VARCHAR, '[]') AS achievements
         FROM activity_segment_effort e LEFT JOIN activity a ON a.id = e.activity_id
         WHERE e.segment_id = $1::BIGINT AND a.deleted_at IS NULL
         ORDER BY e.start_date_local DESC LIMIT $2`,
        [id, limit + 1],
      );
      return {
        data: rows.slice(0, limit).map((r) => ({ ...r, achievements: safeJsonParse(r.achievements) })),

        meta: {
          source: "mirror",
          fetched_at: null,
          truncated: rows.length > limit,
          partial: "Stored projected efforts only; missing activity details/list backfill can omit efforts.",
        },
      };
    },
  };
}

export function contextNote(...items: Cached[]): string {
  return items.map((item) => provenanceText(item.meta)).join("\n");
}

export function promptText(text: string) {
  const limit = 25_000;
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            text.length > limit
              ? `${text.slice(0, limit - 100)}\n[Prompt truncated to 25000 characters; use a smaller window or SQL aggregates.]`
              : text,
        },
      },
    ],
  };
}
