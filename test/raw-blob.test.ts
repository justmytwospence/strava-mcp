/**
 * Large payloads: chunked storage in raw_blob, reassembly through raw_current, edit
 * history, and the migration that moves bodies out of a 3.x raw_payload.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { Database } from "../src/db/database.js";
import { chunkBody, current, land } from "../src/db/raw.js";
import { BLOB_CHUNK_BYTES, MIGRATIONS } from "../src/db/schema.js";
import { createTableSql, table } from "../src/db/tables.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "strava-blob-"));
}

/** An activity detail with enough laps to exceed the inline limit several times over. */
function bigDetail(id: number, laps: number, name = "Long one"): string {
  return JSON.stringify({
    id,
    name,
    sport_type: "Ride",
    start_date: "2026-05-01T10:00:00Z",
    athlete: { id: 7 },
    laps: Array.from({ length: laps }, (_, i) => ({
      id: id * 1000 + i,
      activity: { id },
      athlete: { id: 7 },
      lap_index: i + 1,
      name: `Lap ${i + 1}`,
      distance: 1000.5 * (i + 1),
      elapsed_time: 240 + i,
      moving_time: 230 + i,
    })),
  });
}

describe("chunking", () => {
  test("small bodies are not chunked", () => {
    assert.equal(chunkBody("x".repeat(BLOB_CHUNK_BYTES)), null);
    assert.equal(chunkBody("{}"), null);
  });

  test("chunks stay under the limit, cut on character boundaries, and concatenate back", () => {
    // Two-byte and four-byte characters straddling every boundary.
    const body = "\u00e9".repeat(1999) + "\u{1F6B4}".repeat(1000) + "a".repeat(4001);
    const parts = chunkBody(body)!;
    assert.ok(parts.length >= 3);
    for (const p of parts) {
      assert.ok(Buffer.byteLength(p, "utf8") <= BLOB_CHUNK_BYTES, "part within the byte limit");
      assert.ok(!p.includes("\uFFFD"), "no replacement characters (a cut inside a sequence)");
    }
    assert.equal(parts.join(""), body);
  });
});

describe("landing large payloads", () => {
  test("a large body is stored as chunks and reassembled by raw_current", async () => {
    const dir = tempDir();
    const db = await Database.open({ path: join(dir, "m.duckdb"), snapshotDir: join(dir, "snapshot") });
    try {
      const body = bigDetail(501, 150);
      const parts = chunkBody(body)!;
      assert.ok(parts.length > 2, `expected several chunks, got ${parts.length}`);
      const { changed } = await db.transaction((tx) => land(tx, "activity_detail", "501", body));
      assert.equal(changed, true);
      const stored = await db.one<{ body: string | null }>("SELECT body FROM raw_payload WHERE object_type = 'activity_detail' AND object_key = '501'");
      assert.equal(stored!.body, null, "no inline body");
      const chunks = await db.one<{ n: number; bytes: number }>(
        "SELECT count(*)::INTEGER AS n, sum(strlen(part))::INTEGER AS bytes FROM raw_blob WHERE object_key = '501'",
      );
      assert.equal(chunks!.n, parts.length);
      assert.equal(chunks!.bytes, Buffer.byteLength(body, "utf8"));
      const row = await db.write((tx) => current(tx, "activity_detail", "501"));
      assert.deepEqual(JSON.parse(row!.body!), JSON.parse(body));
      // The projection read the reassembled body.
      assert.equal((await db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM activity_lap WHERE activity_id = 501"))!.n, 150);
      assert.equal((await db.one<{ name: string }>("SELECT name FROM activity WHERE id = 501"))!.name, "Long one");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("edits add a chunked version; unchanged and reverted bodies add nothing", async () => {
    const dir = tempDir();
    const db = await Database.open({ path: join(dir, "m.duckdb"), snapshotDir: join(dir, "snapshot") });
    try {
      const v1 = bigDetail(502, 120, "First");
      const v2 = bigDetail(502, 120, "Renamed");
      const chunkCount = () => db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM raw_blob WHERE object_key = '502'");
      await db.transaction((tx) => land(tx, "activity_detail", "502", v1));
      const after1 = (await chunkCount())!.n;
      assert.equal((await db.transaction((tx) => land(tx, "activity_detail", "502", v1))).changed, false);
      assert.equal((await chunkCount())!.n, after1, "unchanged body adds no chunks");
      assert.equal((await db.transaction((tx) => land(tx, "activity_detail", "502", v2))).changed, true);
      assert.equal((await chunkCount())!.n, 2 * after1, "an edit adds a full second version");
      assert.equal((await db.one<{ name: string }>("SELECT name FROM activity WHERE id = 502"))!.name, "Renamed");
      // Reverting to the first version reuses its stored chunks.
      assert.equal((await db.transaction((tx) => land(tx, "activity_detail", "502", v1))).changed, true);
      assert.equal((await chunkCount())!.n, 2 * after1, "a reverted body reuses its version");
      assert.equal((await db.one<{ name: string }>("SELECT name FROM activity WHERE id = 502"))!.name, "First");
      assert.equal((await db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM raw_payload WHERE object_key = '502'"))!.n, 2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration from the 3.x layout", () => {
  test("bodies over the limit move to raw_blob and raw_current still returns them", async () => {
    const dir = tempDir();
    const path = join(dir, "m.duckdb");
    // A 3.x mirror: only the first migration applied, bodies of every size inline.
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run("CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())");
    // 3.x declared a primary key on the point tables; CREATE TABLE IF NOT EXISTS below keeps it.
    const points = table("activity_stream_point");
    await conn.run(createTableSql({ ...points, keyEnforced: true }));
    for (const step of MIGRATIONS[0] as string[]) await conn.run(step);
    await conn.run("INSERT INTO schema_migration (version) VALUES (1)");
    await conn.run("INSERT INTO activity_stream_point (activity_id, idx, heartrate) SELECT 601, range, 120 + range % 40 FROM range(5000)");
    const big = bigDetail(601, 130);
    const small = JSON.stringify({ id: 602, name: "short", sport_type: "Run", athlete: { id: 7 } });
    const unicode = JSON.stringify({ id: 603, name: "\u{1F6B4}".repeat(1500), sport_type: "Run", athlete: { id: 7 } });
    for (const [key, body] of [["601", big], ["602", small], ["603", unicode]] as const) {
      await conn.run(
        "INSERT INTO raw_payload VALUES ('activity_detail', $1, $2, now(), $3::JSON)",
        [key, `hash-${key}`, body],
      );
      await conn.run("INSERT INTO raw_latest VALUES ('activity_detail', $1, 'ok', $2, now(), now())", [key, `hash-${key}`]);
    }
    conn.closeSync();
    instance.closeSync();

    const db = await Database.open({ path, snapshotDir: join(dir, "snapshot") });
    try {
      const versions = (await db.all<{ version: number }>("SELECT version FROM schema_migration ORDER BY version")).map((r) => Number(r.version));
      assert.deepEqual(versions, MIGRATIONS.map((_, i) => i + 1));
      const inline = await db.all<{ object_key: string; has_body: boolean }>(
        "SELECT object_key, body IS NOT NULL AS has_body FROM raw_payload ORDER BY object_key",
      );
      assert.deepEqual(inline, [
        { object_key: "601", has_body: false },
        { object_key: "602", has_body: true },
        { object_key: "603", has_body: false },
      ]);
      for (const [key, body] of [["601", big], ["602", small], ["603", unicode]] as const) {
        const row = await db.write((tx) => current(tx, "activity_detail", key));
        assert.deepEqual(JSON.parse(row!.body!), JSON.parse(body), key);
      }
      // The point table lost its primary key and kept its rows and comments.
      const keyed = await db.one(
        "SELECT 1 FROM duckdb_constraints() WHERE table_name = 'activity_stream_point' AND constraint_type = 'PRIMARY KEY'",
      );
      assert.equal(keyed, undefined);
      assert.equal((await db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM activity_stream_point WHERE activity_id = 601"))!.n, 5000);
      const comment = await db.one<{ comment: string }>("SELECT comment FROM duckdb_columns() WHERE table_name = 'activity_stream_point' AND column_name = 'heartrate'");
      assert.match(comment!.comment, /bpm/);
      // Landing continues to work on the migrated mirror.
      await db.transaction((tx) => land(tx, "activity_detail", "601", bigDetail(601, 130, "After")));
      assert.equal((await db.one<{ name: string }>("SELECT name FROM activity WHERE id = 601"))!.name, "After");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
