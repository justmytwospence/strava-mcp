/**
 * The published snapshot is a complete, independently readable copy: every table's
 * rows, the views, the comments and the keys, with chunked bodies readable through
 * raw_current.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { Database } from "../src/db/database.js";
import { land } from "../src/db/raw.js";
import { SnapshotPublisher } from "../src/snapshot.js";

const fixtures: Array<{ type: string; key: string; body: unknown }> = JSON.parse(
  readFileSync(new URL("./fixtures/payloads.json", import.meta.url), "utf8"),
);

function streams(n: number): string {
  const series = (f: (i: number) => unknown) => ({ data: Array.from({ length: n }, (_, i) => f(i)), series_type: "distance", original_size: n, resolution: "high" });
  return JSON.stringify({ time: series((i) => i), distance: series((i) => i * 2.5), heartrate: series((i) => 110 + (i % 60)) });
}

test("publish copies every table, view and comment into a readable snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-snapshot-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    for (const f of fixtures) await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
    // Enough points to span several slices of the point table and chunk the payload.
    await db.transaction((tx) => land(tx, "activity_streams", "77001", streams(300_000)));
    const publisher = new SnapshotPublisher(db);
    await publisher.publish();
    assert.ok(existsSync(publisher.path));
    assert.ok(!existsSync(`${publisher.path}.tmp`));

    const live = await db.all<{ name: string; n: number }>(
      `SELECT table_name AS name, 0 AS n FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND NOT temporary ORDER BY 1`,
    );
    for (const t of live) t.n = (await db.one<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM "${t.name}"`))!.n;

    const instance = await DuckDBInstance.create(publisher.path, { access_mode: "READ_ONLY" });
    const conn = await instance.connect();
    const q = async <T>(sql: string) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as T[];
    try {
      for (const t of live) {
        const n = (await q<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM "${t.name}"`))[0]!.n;
        assert.equal(n, t.n, `${t.name} rows`);
      }
      assert.ok(live.some((t) => t.n > 300_000), "the point table spans several row groups");
      const views = await q<{ view_name: string }>("SELECT view_name FROM duckdb_views() WHERE NOT internal");
      assert.ok(views.some((v) => v.view_name === "raw_current"));
      const comment = (await q<{ comment: string }>("SELECT comment FROM duckdb_tables() WHERE table_name = 'activity'"))[0]!.comment;
      assert.match(comment, /One row per Strava activity/);
      const keys = await q<{ table_name: string }>("SELECT table_name FROM duckdb_constraints() WHERE constraint_type = 'PRIMARY KEY'");
      assert.ok(keys.some((k) => k.table_name === "activity"), "keys of the small tables are kept");
      assert.ok(!keys.some((k) => k.table_name === "activity_stream_point"), "no key on the point table");
      const body = (await q<{ n: number }>("SELECT strlen(body::VARCHAR)::INTEGER AS n FROM raw_current WHERE object_type = 'activity_streams' AND object_key = '77001'"))[0]!.n;
      assert.equal(body, streams(300_000).length, "a chunked body reads back whole through the snapshot's raw_current");
    } finally {
      conn.closeSync();
      instance.closeSync();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
