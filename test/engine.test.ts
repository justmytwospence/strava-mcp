/**
 * The scheduler's periodic tasks: the route list interval comes from the environment,
 * with a floor, and the scheduler queues the task only once it is due.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Database } from "../src/db/database.js";
import { DEFAULT_ROUTES_INTERVAL_MINUTES, MIN_ROUTES_INTERVAL_MINUTES, routesInterval, SyncEngine } from "../src/sync/engine.js";
import { MINUTE } from "../src/time.js";

let dir: string;
let db: Database;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "strava-engine-"));
  db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("routes interval", () => {
  test("defaults to an hour, honors the variable, and never goes below the floor", () => {
    assert.equal(routesInterval({}), DEFAULT_ROUTES_INTERVAL_MINUTES * MINUTE);
    assert.equal(routesInterval({ STRAVA_ROUTES_INTERVAL_MINUTES: "" }), DEFAULT_ROUTES_INTERVAL_MINUTES * MINUTE);
    assert.equal(routesInterval({ STRAVA_ROUTES_INTERVAL_MINUTES: "15" }), 15 * MINUTE);
    assert.equal(routesInterval({ STRAVA_ROUTES_INTERVAL_MINUTES: "1" }), MIN_ROUTES_INTERVAL_MINUTES * MINUTE);
    assert.throws(() => routesInterval({ STRAVA_ROUTES_INTERVAL_MINUTES: "soon" }), /STRAVA_ROUTES_INTERVAL_MINUTES/);
  });

  test("the scheduler queues the route list only once the interval has passed", async () => {
    const engine = new SyncEngine(db, { routesIntervalMs: 15 * MINUTE });
    const ranAgo = async (minutes: number) =>
      db.run("INSERT OR REPLACE INTO sync_state (name, value, updated_at) VALUES ('last:routes', $1, now())", [
        new Date(Date.now() - minutes * MINUTE).toISOString(),
      ]);
    const queued = async () => (await db.all("SELECT 1 FROM sync_job WHERE kind = 'routes'")).length;
    await db.run("DELETE FROM sync_job");
    await ranAgo(10);
    await engine.schedule();
    assert.equal(await queued(), 0, "not due yet");
    await ranAgo(20);
    await engine.schedule();
    assert.equal(await queued(), 1, "due");
  });
});
