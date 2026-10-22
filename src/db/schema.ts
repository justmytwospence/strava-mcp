/**
 * Migrations, applied in order and recorded in schema_migration. Never edit a shipped
 * migration: append a new one. The typed tables are generated from tables.ts, so a
 * column added there needs an ALTER TABLE migration here as well (the drift test
 * catches a table whose live columns differ from its definition).
 */
import { TABLES, tableDdl } from "./tables.js";

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

export const MIGRATIONS: string[][] = [[...core, ...TABLES.flatMap(tableDdl)]];
