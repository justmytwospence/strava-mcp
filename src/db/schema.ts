/**
 * Migrations, applied in order and recorded in schema_migration. Never edit a shipped
 * migration: append a new one. The typed tables are generated from tables.ts, so a
 * column added there needs an ALTER TABLE migration here as well (the drift test
 * catches a table whose live columns differ from its definition).
 *
 * A migration is a list of SQL statements and, where data has to be moved in a way
 * SQL alone cannot express, functions run on the same transaction; a migration that
 * must commit in steps is a resumable function instead (see Migration).
 */
import type { Tx } from "./database.js";
import { TABLES, commentSql, createTableSql, tableDdl } from "./tables.js";

export type MigrationStep = string | ((tx: Tx) => Promise<void>);

/**
 * Payload bodies longer than this many bytes are stored as chunks of at most this many
 * bytes in raw_blob rather than inline in raw_payload.body.
 *
 * DuckDB keeps strings of 4 KB or more in overflow blocks, and reading one row of a
 * vector that spans several of its string segments materializes every string of the
 * vector (2,048 rows). With multi-megabyte stream payloads next to small ones that cost
 * hundreds of megabytes per lookup and gigabytes per scan. Chunks under the limit stay
 * inline, compressed, and a vector of them is at most 8 MB.
 */
export const BLOB_CHUNK_BYTES = 4000;

const core: string[] = [
  `CREATE TABLE IF NOT EXISTS raw_payload (
    object_type VARCHAR NOT NULL,
    object_key VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    body JSON NOT NULL,
    PRIMARY KEY (object_type, object_key, content_hash)
  )`,
  `COMMENT ON TABLE raw_payload IS 'Every distinct payload Strava returned, exactly as received (the source of truth; typed tables are rebuilt from it). A new row is added only when the content changes, so this is also the edit history of each object.'`,
  `COMMENT ON COLUMN raw_payload.object_type IS 'Kind of payload: activity_summary, activity_detail, activity_streams, activity_zones, activity_kudos, activity_comments, activity_photos, athlete, athlete_zones, athlete_stats, gear, segment, segment_starred, segment_streams, segment_effort, segment_effort_streams, route_list, route, route_streams, club_list, club.'`,
  `COMMENT ON COLUMN raw_payload.object_key IS 'Id of the object (activity id, segment id, ...; self for singletons).'`,
  `COMMENT ON COLUMN raw_payload.content_hash IS 'SHA-256 of the response body.'`,
  `COMMENT ON COLUMN raw_payload.fetched_at IS 'When this version was first fetched.'`,
  `COMMENT ON COLUMN raw_payload.body IS 'Response body as JSON.'`,
  `CREATE TABLE IF NOT EXISTS raw_latest (
    object_type VARCHAR NOT NULL,
    object_key VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    content_hash VARCHAR,
    fetched_at TIMESTAMPTZ,
    checked_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (object_type, object_key)
  )`,
  `COMMENT ON TABLE raw_latest IS 'The current version of every object: which raw_payload row is live, and when Strava was last asked about it.'`,
  `COMMENT ON COLUMN raw_latest.status IS 'ok, or not_found when Strava answered 404 (deleted, or no streams for a manual activity).'`,
  `COMMENT ON COLUMN raw_latest.checked_at IS 'Last time the object was fetched, whether or not it had changed.'`,
  `CREATE VIEW IF NOT EXISTS raw_current AS
    SELECT l.object_type, l.object_key, l.status, l.checked_at, p.fetched_at, p.body
    FROM raw_latest l LEFT JOIN raw_payload p USING (object_type, object_key, content_hash)`,
  `CREATE TABLE IF NOT EXISTS sync_job (
    kind VARCHAR NOT NULL,
    key VARCHAR NOT NULL,
    priority INTEGER NOT NULL,
    sort_key BIGINT NOT NULL DEFAULT 0,
    not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, key)
  )`,
  `COMMENT ON TABLE sync_job IS 'Durable work queue of the sync worker. Lower priority runs first; within a priority, higher sort_key (newer activity) first.'`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    name VARCHAR PRIMARY KEY,
    value VARCHAR,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `COMMENT ON TABLE sync_state IS 'Scheduler bookkeeping (last run of each periodic task).'`,
  `CREATE TABLE IF NOT EXISTS rate_sample (
    observed_at TIMESTAMPTZ NOT NULL,
    method VARCHAR,
    path VARCHAR,
    status INTEGER,
    priority VARCHAR,
    usage_15min INTEGER,
    usage_daily INTEGER,
    limit_15min INTEGER,
    limit_daily INTEGER,
    read_usage_15min INTEGER,
    read_usage_daily INTEGER,
    read_limit_15min INTEGER,
    read_limit_daily INTEGER
  )`,
  `COMMENT ON TABLE rate_sample IS 'Every Strava API request with the rate-limit headers it returned (null when Strava sent none, e.g. activity streams). Pruned after 30 days.'`,
  `CREATE TABLE IF NOT EXISTS sync_log (
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind VARCHAR,
    key VARCHAR,
    outcome VARCHAR,
    detail VARCHAR
  )`,
  `COMMENT ON TABLE sync_log IS 'Outcome of each sync job (ok, changed, not_found, error). Pruned after 30 days.'`,
];

/**
 * The body of a payload, whether stored inline or as chunks. `key` names a row with
 * object_type, object_key and content_hash (raw_latest, or raw_payload itself) and
 * `payload` the raw_payload row. The correlated subquery decorrelates into a join whose
 * keys DuckDB pushes into the raw_blob scan as dynamic filters, so a lookup by key, a
 * join from a key list, and a whole-type scan each read only the chunks they need.
 */
export function bodyExpr(key: string, payload: string): string {
  return `coalesce(${payload}.body, (
    SELECT string_agg(b.part, '' ORDER BY b.chunk_no) FROM raw_blob b
    WHERE b.object_type = ${key}.object_type AND b.object_key = ${key}.object_key AND b.content_hash = ${key}.content_hash
  )::JSON)`;
}

/** bodyExpr for the usual aliases: raw_latest l joined with raw_payload p. */
export const BODY_EXPR = bodyExpr("l", "p");

const RAW_PAYLOAD_V2 = `(
    object_type VARCHAR NOT NULL,
    object_key VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    body JSON,
    PRIMARY KEY (object_type, object_key, content_hash)
  )`;

const rawPayloadComments: string[] = [
  `COMMENT ON TABLE raw_payload IS 'Every distinct payload Strava returned, exactly as received (the source of truth; typed tables are rebuilt from it). A new row is added only when the content changes, so this is also the edit history of each object. Bodies over ${BLOB_CHUNK_BYTES} bytes are stored in raw_blob; read raw_current for the body of any payload.'`,
  `COMMENT ON COLUMN raw_payload.object_type IS 'Kind of payload: activity_summary, activity_detail, activity_streams, activity_zones, activity_kudos, activity_comments, activity_photos, athlete, athlete_zones, athlete_stats, gear, segment, segment_starred, segment_streams, segment_effort, segment_effort_streams, route_list, route, route_streams, route_gpx, route_tcx, club_list, club.'`,
  `COMMENT ON COLUMN raw_payload.object_key IS 'Id of the object (activity id, segment id, ...; self for singletons).'`,
  `COMMENT ON COLUMN raw_payload.content_hash IS 'SHA-256 of the response body.'`,
  `COMMENT ON COLUMN raw_payload.fetched_at IS 'When this version was first fetched.'`,
  `COMMENT ON COLUMN raw_payload.body IS 'Response body as JSON when it is at most ${BLOB_CHUNK_BYTES} bytes; NULL when it is stored as chunks in raw_blob (streams, long activity details).'`,
];

const RAW_BLOB_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS raw_blob (
    object_type VARCHAR NOT NULL,
    object_key VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    chunk_no INTEGER NOT NULL,
    part VARCHAR NOT NULL
  )`,
  `COMMENT ON TABLE raw_blob IS 'Bodies of payloads over ${BLOB_CHUNK_BYTES} bytes (activity streams, long activity details, route exports), split into chunks of at most ${BLOB_CHUNK_BYTES} bytes so that no DuckDB vector holds more than a few megabytes of text. Rows are unique by (object_type, object_key, content_hash, chunk_no). Concatenate the parts in chunk_no order to get the body; raw_current does this.'`,
  `COMMENT ON COLUMN raw_blob.chunk_no IS '0-based position of this part within the body.'`,
  `COMMENT ON COLUMN raw_blob.part IS 'A slice of the body text, split on UTF-8 character boundaries.'`,
];

const RAW_CURRENT_DDL: string[] = [
  `CREATE VIEW raw_current AS
    SELECT l.object_type, l.object_key, l.status, l.checked_at, p.fetched_at, ${BODY_EXPR} AS body
    FROM raw_latest l LEFT JOIN raw_payload p USING (object_type, object_key, content_hash)`,
  `COMMENT ON VIEW raw_current IS 'The current payload of every object with its body (inline or reassembled from raw_blob): the view to query for raw JSON.'`,
];

const PROGRESS_KEY = "migration:2:next_row";

async function tableExists(tx: Tx, name: string): Promise<boolean> {
  return !!(await tx.one("SELECT 1 FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = $1", [name]));
}

/**
 * Large payloads move out of raw_payload into chunked raw_blob rows (migration 2).
 *
 * raw_blob has no primary key on purpose: an ART index over hundreds of thousands of
 * chunk rows is rewritten at every checkpoint (seconds and hundreds of megabytes each
 * time), and uniqueness of (object_type, object_key, content_hash, chunk_no) is
 * guaranteed by the landing code, which only writes chunks for a version it has not
 * stored.
 *
 * The move runs in its own transactions, one per 2,048-row vector of the old table,
 * and records its progress in sync_state, so an interrupted run resumes where it
 * stopped and memory is bounded by one vector. Reading a vector of the old table
 * materializes every body in it (the reason for this migration), so on a large 3.x
 * mirror that is still several hundred megabytes.
 */
async function moveLargePayloads(tx: Tx): Promise<void> {
  // Already swapped (only the version record was lost): nothing to do.
  if ((await tableExists(tx, "raw_blob")) && !(await tableExists(tx, "raw_payload_v2"))) return;
  await tx.run("BEGIN TRANSACTION");
  for (const sql of RAW_BLOB_DDL) await tx.run(sql);
  await tx.run(`CREATE TABLE IF NOT EXISTS raw_payload_v2 ${RAW_PAYLOAD_V2}`);
  await tx.run("COMMIT");

  const total = (await tx.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM raw_payload"))!.n;
  const last = Number((await tx.one<{ m: number | null }>("SELECT max(rowid)::BIGINT AS m FROM raw_payload"))?.m ?? -1);
  const progress = await tx.one<{ value: string }>("SELECT value FROM sync_state WHERE name = $1", [PROGRESS_KEY]);
  const STEP = 2048;
  let from = progress ? Number(progress.value) : 0;
  if (total > 0 && from <= last) console.error(`mirror: moving large payloads of ${total} stored responses into raw_blob (one-time migration)`);
  for (; from <= last; from += STEP) {
    const where = `rowid >= ${from} AND rowid < ${from + STEP}`;
    await tx.run("BEGIN TRANSACTION");
    // The chunk list is built per row and then unnested, so a body is never copied once per chunk.
    await tx.run(`INSERT INTO raw_blob
      SELECT object_type, object_key, content_hash, unnest(range(n))::INTEGER,
             unnest(list_transform(range(n), i -> substr(body::VARCHAR, i * ${BLOB_CHUNK_BYTES} + 1, ${BLOB_CHUNK_BYTES})))
      FROM (SELECT object_type, object_key, content_hash, body, ceil(length(body::VARCHAR) / ${BLOB_CHUNK_BYTES}.0)::BIGINT AS n
            FROM raw_payload WHERE ${where} AND strlen(body::VARCHAR) > ${BLOB_CHUNK_BYTES})`);
    await tx.run(`INSERT INTO raw_payload_v2
      SELECT object_type, object_key, content_hash, fetched_at, CASE WHEN strlen(body::VARCHAR) > ${BLOB_CHUNK_BYTES} THEN NULL ELSE body END
      FROM raw_payload WHERE ${where}`);
    await tx.run("INSERT OR REPLACE INTO sync_state (name, value, updated_at) VALUES ($1, $2, now())", [PROGRESS_KEY, String(from + STEP)]);
    await tx.run("COMMIT");
  }

  await tx.run("BEGIN TRANSACTION");
  await tx.run("DROP VIEW IF EXISTS raw_current");
  await tx.run("DROP TABLE raw_payload");
  await tx.run("ALTER TABLE raw_payload_v2 RENAME TO raw_payload");
  for (const sql of [...rawPayloadComments, ...RAW_CURRENT_DDL]) await tx.run(sql);
  await tx.run("DELETE FROM sync_state WHERE name = $1", [PROGRESS_KEY]);
  await tx.run("COMMIT");
}

/**
 * Rebuild the point tables that still carry the primary key 3.x declared (see
 * Table.keyEnforced). DuckDB cannot drop a primary key, so the table is copied.
 */
async function dropPointTableKeys(tx: Tx): Promise<void> {
  for (const t of TABLES.filter((t) => t.keyEnforced === false)) {
    const constrained = await tx.one(
      "SELECT 1 FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = $1 AND constraint_type = 'PRIMARY KEY'",
      [t.name],
    );
    if (!constrained) continue;
    const rebuilt = `${t.name}_v2`;
    await tx.run(createTableSql(t, rebuilt));
    await tx.run(`INSERT INTO ${rebuilt} SELECT * FROM ${t.name}`);
    await tx.run(`DROP TABLE ${t.name}`);
    await tx.run(`ALTER TABLE ${rebuilt} RENAME TO ${t.name}`);
    for (const sql of commentSql(t)) await tx.run(sql);
  }
}

/**
 * A migration is either a list of steps run in one transaction, or a resumable function
 * that manages its own transactions and is safe to run again after an interruption.
 */
export type Migration = MigrationStep[] | { resumable: (tx: Tx) => Promise<void> };

export const MIGRATIONS: Migration[] = [
  [...core, ...TABLES.flatMap(tableDdl)],
  { resumable: moveLargePayloads },
  [dropPointTableKeys],
];
