/**
 * The mirror against scrubbed real payloads (test/fixtures/payloads.json, one or more
 * of every payload type Strava returned for a real account, with personal values
 * replaced): landing, projection into typed tables, drift, deletion, history, and the
 * sync planner.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Database } from "../src/db/database.js";
import { drift } from "../src/db/projections.js";
import { land, landMany, markNotFound } from "../src/db/raw.js";
import { TABLES } from "../src/db/tables.js";
import { SyncEngine } from "../src/sync/engine.js";

interface Fixture {
  type: string;
  key: string;
  body: unknown;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./fixtures/payloads.json", import.meta.url), "utf8"));
const of = (type: string) => fixtures.filter((f) => f.type === type);

let dir: string;
let db: Database;

async function count(table: string, where = "true"): Promise<number> {
  return (await db.one<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM ${table} WHERE ${where}`))!.n;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "strava-mirror-test-"));
  db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  for (const f of fixtures) {
    await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
  }
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("projection", () => {
  test("every typed table matches its definition", async () => {
    for (const t of TABLES) {
      const cols = await db.all<{ name: string }>(
        "SELECT column_name AS name FROM duckdb_columns() WHERE table_name = $1 ORDER BY column_index",
        [t.name],
      );
      assert.deepEqual(cols.map((c) => c.name), t.columns.map((c) => c.name), t.name);
    }
  });

  test("no field Strava returned is left unmapped", async () => {
    assert.deepEqual(await db.write((tx) => drift(tx)), []);
  });

  test("activities merge summary and detail", async () => {
    assert.equal(await count("activity"), of("activity_summary").length);
    const detailed = of("activity_detail").length;
    assert.equal(await count("activity", "detail_fetched_at IS NOT NULL"), detailed);
    assert.equal(await count("activity", "description IS NOT NULL"), detailed);
    assert.ok((await count("activity", "start_date IS NOT NULL AND sport_type IS NOT NULL")) > 0);
  });

  test("detail children land in their tables", async () => {
    for (const t of ["activity_lap", "activity_split", "activity_segment_effort", "segment"]) {
      assert.ok((await count(t)) > 0, t);
    }
  });

  test("streams unnest into aligned points", async () => {
    const meta = await db.all<{ activity_id: string; n: number }>(
      "SELECT activity_id::VARCHAR AS activity_id, max(original_size)::INTEGER AS n FROM activity_stream_meta GROUP BY 1",
    );
    assert.ok(meta.length > 0);
    // The fixtures keep five points per stream.
    for (const m of meta) assert.equal(await count("activity_stream_point", `activity_id = ${m.activity_id}`), 5);
    assert.ok((await count("activity_stream_point", "lat IS NOT NULL AND lng IS NOT NULL")) > 0);
  });

  test("singletons and lists", async () => {
    assert.equal(await count("athlete"), 1);
    assert.ok((await count("athlete_zone")) > 0);
    assert.equal(await count("athlete_stats"), 9);
    assert.ok((await count("gear")) > 0);
    assert.ok((await count("route")) > 0);
    assert.ok((await count("route_point")) > 0);
    assert.ok((await count("club")) > 0);
    assert.ok((await count("segment", "starred")) > 0);
  });
});

describe("landing", () => {
  test("an unchanged payload adds no history", async () => {
    const f = of("activity_summary")[0]!;
    const before = await count("raw_payload");
    const { changed } = await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
    assert.equal(changed, false);
    assert.equal(await count("raw_payload"), before);
  });

  test("an edit adds a version and updates the typed row", async () => {
    const f = of("activity_summary")[0]!;
    const edited = { ...(f.body as Record<string, unknown>), name: "Renamed" };
    const changed = await db.transaction((tx) => landMany(tx, f.type, [{ key: f.key, body: JSON.stringify(edited) }]));
    assert.deepEqual(changed, [f.key]);
    assert.equal(await count("raw_payload", `object_type = 'activity_summary' AND object_key = '${f.key}'`), 2);
    // The summary is now newer than the detail, so its name wins.
    assert.equal(await count("activity", `id = ${f.key} AND name = 'Renamed'`), 1);
  });

  test("64-bit ids keep their precision", async () => {
    const big = "3377135020653606222";
    await db.transaction((tx) =>
      land(tx, "segment_effort", big, `{"id": ${big}, "name": "big", "activity": {"id": 1}, "segment": {"id": 2}}`),
    );
    assert.equal(await count("activity_segment_effort", `id = ${big}`), 1);
  });

  test("a 404 marks the activity deleted but keeps its data", async () => {
    const f = of("activity_summary")[1]!;
    await db.transaction((tx) => markNotFound(tx, "activity_summary", f.key));
    assert.equal(await count("activity", `id = ${f.key} AND deleted_at IS NOT NULL`), 1);
  });

  test("athlete stats keep history", async () => {
    const f = of("athlete_stats")[0]!;
    const body = f.body as Record<string, Record<string, number>>;
    const next = { ...body, ytd_run_totals: { ...body.ytd_run_totals, count: 999 } };
    await db.transaction((tx) => land(tx, "athlete_stats", "self", JSON.stringify(next)));
    assert.equal(await count("athlete_stats"), 18);
  });
});

describe("planner", () => {
  test("gaps become jobs, and planning twice adds nothing", async () => {
    const engine = new SyncEngine(db);
    await engine.plan();
    const jobs = await db.all<{ kind: string; key: string }>("SELECT kind, key FROM sync_job");
    const kinds = new Set(jobs.map((j) => j.kind));
    // The manual activity has no detail yet and no streams to fetch.
    assert.ok(kinds.has("activity_detail"));
    const manual = of("activity_summary").find((f) => (f.body as { manual?: boolean }).manual);
    if (manual) assert.ok(!jobs.some((j) => j.kind === "activity_streams" && j.key === manual.key));
    // Deleted activities are not planned.
    const deleted = of("activity_summary")[1]!.key;
    assert.ok(!jobs.some((j) => j.key === deleted && j.kind.startsWith("activity_")));
    const n = jobs.length;
    await engine.plan();
    assert.equal(await count("sync_job"), n);
  });
});
