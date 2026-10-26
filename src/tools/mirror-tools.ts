import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CHARACTER_LIMIT } from "../constants.js";
import { mirror } from "../context.js";
import type { Database } from "../db/database.js";
import { schema } from "../db/inspection.js";
import { drift } from "../db/projections.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import { LOCAL_READ_ONLY } from "./annotations.js";

/** Run one statement in an engine-enforced read-only transaction on a serialized connection. */
export async function runReadOnly(
  sql: string,
  maxRows: number,
): Promise<{ columns: string[]; rows: unknown[]; truncated: boolean }> {
  return mirror().db.query.run(sql, maxRows);
}

const DRIFT_TTL_MS = 60 * 60_000;
const driftCache = new WeakMap<Database, { at: number; value: Awaited<ReturnType<typeof drift>> }>();

export function register(server: McpServer): void {
  server.registerTool(
    "strava_query",
    {
      title: "Query the Strava Mirror (SQL)",
      description:
        "Run a read-only DuckDB SQL query against the athlete's stored Strava data (possibly incomplete; check sync status). Enforced read-only transaction, 30 seconds, 5000 rows maximum; no file/network access. Use strava_schema first to see the tables. " +
        "Main tables: activity, activity_stream_point (per-point streams: time, distance, lat, lng, altitude, heartrate, cadence, watts, temp, velocity_smooth, grade_smooth), " +
        "activity_lap, activity_split, activity_best_effort, activity_segment_effort, segment, activity_zone_bucket, gear, route, athlete_stats. " +
        "Units: meters, seconds, m/s. raw_current holds every payload as JSON (column body) for fields not in a typed table. Costs no Strava API calls.",
      inputSchema: z.object({
        sql: z
          .string()
          .min(1)
          .max(100_000)
          .describe("One DuckDB SELECT statement (DESCRIBE, SUMMARIZE and EXPLAIN also work)."),
        max_rows: z.coerce
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(200)
          .describe("Maximum rows to return (default 200)."),
      }),
      annotations: LOCAL_READ_ONLY,
      outputSchema: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.unknown()),
        row_count: z.number().int(),
        truncated: z.boolean(),
        note: z.string().optional(),
      }),
    },
    async ({ sql, max_rows }) => {
      try {
        const result = await runReadOnly(sql, max_rows);
        const data = {
          ...result,
          row_count: result.rows.length,
          note: result.truncated ? `Truncated to ${max_rows} rows; aggregate or add LIMIT/OFFSET.` : undefined,
        };
        while (JSON.stringify(data, null, 2).length > CHARACTER_LIMIT && data.rows.length) {
          data.rows = data.rows.slice(0, Math.floor(data.rows.length / 2));
          data.row_count = data.rows.length;
          data.truncated = true;
          data.note = "Truncated by the character budget; select fewer/smaller fields or aggregate.";
        }
        if (JSON.stringify(data, null, 2).length > CHARACTER_LIMIT)
          throw new Error("Column metadata exceeds output budget; select fewer columns.");
        return jsonResult(data);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_schema",
    {
      title: "Describe the Strava Mirror",
      description:
        "List the mirror's tables and views with their descriptions and row counts, or, given a table name, its columns with types, units and descriptions. Use before strava_query.",
      inputSchema: z.object({
        table: z.string().min(1).max(128).optional().describe("A table or view name; omit to list them all."),
      }),
      annotations: LOCAL_READ_ONLY,
      outputSchema: z.object({
        tables: z
          .array(
            z.object({
              name: z.string(),
              kind: z.enum(["table", "view"]),
              approx_rows: z.string().nullable(),
              comment: z.string().nullable(),
            }),
          )
          .optional(),
        table: z.string().optional(),
        comment: z.string().nullable().optional(),
        columns: z.array(z.object({ name: z.string(), type: z.string(), comment: z.string().nullable() })).optional(),
      }),
    },
    async ({ table }) => {
      try {
        const data = await schema(mirror().db, table);
        if (JSON.stringify(data, null, 2).length > CHARACTER_LIMIT)
          throw new Error("Schema exceeds output budget; request a single table.");
        return jsonResult(data);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_sync_status",
    {
      title: "Strava Mirror Sync Status",
      description:
        "How complete and fresh the local mirror is: activity coverage (details, streams, zones), the sync queue by kind, last run of each periodic task, recent errors, and unmapped fields. Zero API calls. Rate status distinguishes header observations from local estimates and unknown pools; missing headers never mean free calls. Check this or strava://mirror/budget before broad remote reads; 429 cooldown/reset times apply to all priorities.",
      inputSchema: z.object({}),
      annotations: LOCAL_READ_ONLY,
    },
    async () => {
      try {
        const m = mirror();
        const status = await m.engine.status();
        // The drift check scans stored payloads, so it is reused for an hour.
        let cached = driftCache.get(m.db);
        if (!cached || Date.now() - cached.at > DRIFT_TTL_MS) {
          cached = { at: Date.now(), value: await m.db.write((tx) => drift(tx)) };
          driftCache.set(m.db, cached);
        }
        const unmapped = cached.value;
        return jsonResult({ ...status, unmapped_fields: unmapped });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
