import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DuckDBConnection } from "@duckdb/node-api";
import { setMirror } from "../src/context.js";
import { Database } from "../src/db/database.js";
import { ReadOnlyQuery } from "../src/db/read-only.js";
import type { Mirror } from "../src/mirror.js";
import { runReadOnly } from "../src/tools/mirror-tools.js";

for (const memory of [true, false]) {
  test(`actual node driver SQL safety (${memory ? "memory" : "file"} fixture)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "strava-query-test-"));
    const protectedFile = join(dir, "tokens.json");
    const exported = join(dir, "export.csv");
    writeFileSync(protectedFile, "synthetic-protected-sentinel");
    const db = await Database.open({ path: memory ? ":memory:" : join(dir, "fixture.duckdb"), snapshotDir: dir });
    setMirror({ db } as Mirror);
    try {
      await db.run("CREATE TABLE sentinel (n INTEGER); INSERT INTO sentinel VALUES (42); CREATE SEQUENCE seq");
      for (const sql of [
        "INSERT INTO sentinel VALUES (9)",
        "UPDATE sentinel SET n = 9",
        "DELETE FROM sentinel",
        "DROP TABLE sentinel",
        "CREATE TABLE forbidden(n INTEGER)",
        "ALTER TABLE sentinel ADD COLUMN extra INTEGER",
        "EXPLAIN ANALYZE INSERT INTO sentinel VALUES (9)",
        "EXPLAIN ANALYZE UPDATE sentinel SET n = 9",
        "EXPLAIN ANALYZE DELETE FROM sentinel",
        "EXPLAIN ANALYZE CREATE OR REPLACE TABLE sentinel AS SELECT 9 AS n",
        "SELECT * FROM query('EXPLAIN ANALYZE DELETE FROM sentinel')",
        "EXPLAIN ANALYZE CREATE TABLE forbidden AS SELECT 1",
        "EXPLAIN ANALYZE DROP TABLE sentinel",
        "SELECT nextval('seq')",
        "SELECT 1; DELETE FROM sentinel",
        "BEGIN TRANSACTION",
        "COMMIT",
        "SET enable_external_access = true",
        `SELECT * FROM read_text('${protectedFile}')`,
        `SELECT * FROM read_csv('${protectedFile}')`,
        `COPY sentinel TO '${exported}'`,
        `EXPLAIN ANALYZE COPY sentinel TO '${exported}'`,
        `ATTACH '${join(dir, "other.duckdb")}' AS other`,
        "SELECT * FROM missing_table",
      ]) {
        await assert.rejects(runReadOnly(sql, 10), { name: "Error" }, sql);
        assert.deepEqual((await runReadOnly("SELECT * FROM sentinel", 10)).rows, [{ n: 42 }], sql);
        assert.equal(readFileSync(protectedFile, "utf8"), "synthetic-protected-sentinel");
        assert.equal(existsSync(exported), false);
      }
      for (const sql of [
        "DESCRIBE sentinel",
        "SUMMARIZE sentinel",
        "EXPLAIN SELECT * FROM sentinel",
        "PRAGMA table_info('sentinel')",
        "FROM sentinel SELECT *",
      ]) {
        assert.ok((await runReadOnly(sql, 10)).rows.length > 0, sql);
      }
      assert.equal((await runReadOnly("SELECT * FROM range(10)", 2)).truncated, true);
      const concurrent = await Promise.all(Array.from({ length: 12 }, (_, i) => runReadOnly(`SELECT ${i} AS n`, 1)));
      assert.deepEqual(
        concurrent.map((r) => r.rows[0]),
        Array.from({ length: 12 }, (_, n) => ({ n })),
      );
      await assert.rejects(db.query.run("SELECT sum(a.i*b.i) FROM range(10000000) a(i), range(10000000) b(i)", 1, 5));
      assert.deepEqual((await runReadOnly("SELECT * FROM sentinel", 1)).rows, [{ n: 42 }]);
      // Neither a failed prepare nor an interrupted execute strands the reader, and writer commits stay visible.
      await db.run("UPDATE sentinel SET n = 43");
      assert.deepEqual((await runReadOnly("SELECT * FROM sentinel", 1)).rows, [{ n: 43 }]);
      assert.equal((await db.one("SELECT nextval('seq') AS n"))?.n, "1");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("read-only setup and rollback fail closed, before preparation, without connection reuse", async () => {
  const events: string[] = [];
  const conn = {
    run: async (sql: string) => {
      events.push(sql);
      if (sql === "ROLLBACK") throw new Error("synthetic cleanup failure");
    },
    extractStatements: async () => {
      events.push("extract");
      return {
        count: 1,
        prepare: async () => {
          events.push("prepare");
          throw new Error("bind failure");
        },
      };
    },
    closeSync: () => events.push("close"),
  } as unknown as DuckDBConnection;
  let connections = 0;
  const query = new ReadOnlyQuery(async () => {
    connections++;
    return conn;
  });
  await assert.rejects(query.run("SELECT 1", 1), /rollback failed/);
  assert.deepEqual(events, ["BEGIN TRANSACTION READ ONLY", "extract", "prepare", "ROLLBACK", "close"]);
  await assert.rejects(query.run("SELECT 1", 1));
  assert.equal(connections, 2);
  events.length = 0;
  conn.run = async (sql: string) => {
    events.push(sql);
    throw new Error("unsupported");
  };
  await assert.rejects(query.run("SELECT 1", 1), /unsupported/);
  assert.deepEqual(events, ["BEGIN TRANSACTION READ ONLY", "close"]);
});
