/**
 * Stream projections stay within a tight memory limit. DuckDB parses JSON afresh for every
 * extraction expression, so pulling ten channels out of a long activity's streams one by one
 * needed more than 384 MB; the projection extracts all channels in one pass.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/db/database.js";
import { land } from "../src/db/raw.js";

function streams(n: number): string {
  const series = (f: (i: number) => unknown) => ({ data: Array.from({ length: n }, (_, i) => f(i)), series_type: "distance", original_size: n, resolution: "high" });
  return JSON.stringify({
    time: series((i) => i),
    distance: series((i) => i * 3.217),
    latlng: series((i) => [37.123456 + i * 1e-6, -122.654321 - i * 1e-6]),
    altitude: series((i) => 100 + (i % 500) * 0.1),
    velocity_smooth: series((i) => 3.1 + (i % 7) * 0.01),
    heartrate: series((i) => 120 + (i % 40)),
    cadence: series((i) => 80 + (i % 10)),
    watts: series((i) => 200 + (i % 90)),
    temp: series((i) => 18 + (i % 3)),
    moving: series((i) => i % 13 !== 0),
    grade_smooth: series((i) => (i % 21) * 0.1 - 1),
  });
}

test("projecting one activity does not read every stored stream payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-mem-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    const body = streams(30_000);
    for (let i = 0; i < 60; i++) await db.transaction((tx) => land(tx, "activity_streams", String(1000 + i), body));
    await db.close();
    const small = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot"), memoryLimit: "256MB", threads: 2 });
    try {
      await small.transaction((tx) => land(tx, "activity_streams", "999", body));
      const rows = await small.all("SELECT count(*)::INT AS n FROM activity_stream_point WHERE activity_id = 999");
      assert.equal(rows[0].n, 30_000);
    } finally {
      await small.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long activity's streams land under a 256 MB memory limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-mem-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot"), memoryLimit: "256MB", threads: 2 });
  try {
    const body = streams(60_000);
    await db.transaction((tx) => land(tx, "activity_streams", "123", body));
    const rows = await db.all("SELECT count(*)::INT AS n, count(heartrate)::INT AS hr, count(lat)::INT AS lat FROM activity_stream_point WHERE activity_id = 123");
    assert.deepEqual(rows[0], { n: 60_000, hr: 60_000, lat: 60_000 });
    const meta = await db.all("SELECT count(*)::INT AS n, min(original_size)::INT AS size, min(resolution) AS res FROM activity_stream_meta WHERE activity_id = 123");
    assert.deepEqual(meta[0], { n: 11, size: 60_000, res: "high" });
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
