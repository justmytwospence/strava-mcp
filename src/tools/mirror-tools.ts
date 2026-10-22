import { McpServer } from "@modelcontextprotocol/server";
import { type DuckDBConnection, StatementType } from "@duckdb/node-api";
import { z } from "zod";
import { mirror } from "../context.js";
import { drift } from "../db/projections.js";
import { formatToolError } from "../errors.js";
import { jsonResult, textResult } from "../format.js";

const QUERY_TIMEOUT_MS = 30_000;
let readConnection: Promise<DuckDBConnection> | null = null;

function reader(): Promise<DuckDBConnection> {
  readConnection ??= mirror().db.connect();
  return readConnection;
}

/**
 * Run one read-only statement on its own connection. Only SELECT (which covers
 * DESCRIBE, SHOW, SUMMARIZE, PRAGMA table_info, FROM-first queries) and EXPLAIN are
 * accepted; file access from SQL is disabled for the whole database.
 */
export async function runReadOnly(sql: string, maxRows: number): Promise<{ columns: string[]; rows: unknown[]; truncated: boolean }> {
  const conn = await reader();
  const extracted = await conn.extractStatements(sql);
  if (extracted.count !== 1) throw new Error(`Send exactly one statement (got ${extracted.count}).`);
  const prepared = await extracted.prepare(0);
  if (prepared.statementType !== StatementType.SELECT && prepared.statementType !== StatementType.EXPLAIN) {
    throw new Error(`Only read-only queries are allowed (got ${StatementType[prepared.statementType]}).`);
  }
  const timer = setTimeout(() => conn.interrupt(), QUERY_TIMEOUT_MS);
  try {
    const reader = await prepared.runAndReadUntil(maxRows + 1);
    const rows = reader.getRowObjectsJson();
    return { columns: reader.columnNames(), rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
  } finally {
    clearTimeout(timer);
  }
}

export function register(server: McpServer): void {
  server.registerTool(
    "strava_query",
    {
      title: "Query the Strava Mirror (SQL)",
      description:
        "Run a read-only DuckDB SQL query against the local mirror of all the athlete's Strava data. Use strava_schema first to see the tables. " +
        "Main tables: activity, activity_stream_point (per-point streams: time, distance, lat, lng, altitude, heartrate, cadence, watts, temp, velocity_smooth, grade_smooth), " +
        "activity_lap, activity_split, activity_best_effort, activity_segment_effort, segment, activity_zone_bucket, gear, route, athlete_stats. " +
        "Units: meters, seconds, m/s. raw_current holds every payload as JSON (column body) for fields not in a typed table. Costs no Strava API calls.",
      inputSchema: z.object({
        sql: z.string().describe("One DuckDB SELECT statement (DESCRIBE, SUMMARIZE and EXPLAIN also work)."),
        max_rows: z.coerce.number().int().min(1).max(5000).default(200).describe("Maximum rows to return (default 200)."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, max_rows }: { sql: string; max_rows: number }) => {
      try {
        const result = await runReadOnly(sql, max_rows);
        return jsonResult({
          columns: result.columns,
          rows: result.rows,
          row_count: result.rows.length,
          ...(result.truncated ? { note: `Truncated to ${max_rows} rows; aggregate or add LIMIT/OFFSET.` } : {}),
        });
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
        table: z.string().optional().describe("A table or view name; omit to list them all."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table }: { table?: string }) => {
      try {
        const db = mirror().db;
        if (!table) {
          const tables = await db.all(
            `SELECT table_name AS name, 'table' AS kind, estimated_size::BIGINT AS approx_rows, comment
             FROM duckdb_tables() WHERE schema_name = 'main' AND NOT internal AND NOT temporary
             UNION ALL
             SELECT view_name, 'view', NULL, comment FROM duckdb_views() WHERE schema_name = 'main' AND NOT internal AND NOT temporary
             ORDER BY kind, name`,
          );
          return jsonResult({ tables });
        }
        const columns = await db.all(
          `SELECT column_name AS name, data_type AS type, comment FROM duckdb_columns()
           WHERE schema_name = 'main' AND table_name = $1 ORDER BY column_index`,
          [table],
        );
        if (columns.length === 0) return textResult(`No table or view named ${table}. Call strava_schema without arguments to list them.`);
        const meta = await db.one(
          `SELECT comment FROM duckdb_tables() WHERE schema_name = 'main' AND table_name = $1
           UNION ALL SELECT comment FROM duckdb_views() WHERE schema_name = 'main' AND view_name = $1`,
          [table],
        );
        return jsonResult({ table, comment: (meta as { comment?: string } | undefined)?.comment ?? null, columns });
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
        "How complete and fresh the local mirror is: activity coverage (details, streams, zones), the sync queue by kind, last run of each periodic task, recent errors, rate-limit usage, and any fields Strava returns that the schema does not yet map.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const m = mirror();
        const status = await m.engine.status();
        const unmapped = await m.db.write((tx) => drift(tx));
        return jsonResult({ ...status, unmapped_fields: unmapped });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
