import type { Database } from "./database.js";

/** Shared by the schema tool and resources. All identifiers remain bound values. */
export async function schema(db: Database, table?: string) {
  if (!table) {
    const tables = await db.all(
      `SELECT table_name AS name, 'table' AS kind, estimated_size::BIGINT AS approx_rows, comment
       FROM duckdb_tables() WHERE schema_name = 'main' AND NOT internal AND NOT temporary
       UNION ALL
       SELECT view_name, 'view', NULL, comment FROM duckdb_views() WHERE schema_name = 'main' AND NOT internal AND NOT temporary
       ORDER BY kind, name`,
    );
    return { tables };
  }
  const columns = await db.all(
    `SELECT column_name AS name, data_type AS type, comment FROM duckdb_columns()
     WHERE schema_name = 'main' AND table_name = $1 ORDER BY column_index`,
    [table],
  );
  if (columns.length === 0)
    throw new Error(`No table or view named ${table}. Call strava_schema without arguments to list them.`);
  const meta = await db.one<{ comment: string | null }>(
    `SELECT comment FROM duckdb_tables() WHERE schema_name = 'main' AND table_name = $1
     UNION ALL SELECT comment FROM duckdb_views() WHERE schema_name = 'main' AND view_name = $1`,
    [table],
  );
  return { table, comment: meta?.comment ?? null, columns };
}
