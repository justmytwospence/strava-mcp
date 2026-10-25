/**
 * GET /export/sync's payload: starred routes with their start point, and the
 * activities since a time, from the fixtures; deleted activities and unstarred routes
 * are left out.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/db/database.js";
import { land } from "../src/db/raw.js";
import { polylineStart, syncExport } from "../src/export.js";

const fixtures: Array<{ type: string; key: string; body: unknown }> = JSON.parse(
  readFileSync(new URL("./fixtures/payloads.json", import.meta.url), "utf8"),
);

test("polylineStart decodes the first point", () => {
  // Google's documented example starts at (38.5, -120.2).
  assert.deepEqual(polylineStart("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [38.5, -120.2]);
  assert.equal(polylineStart(""), null);
  assert.equal(polylineStart(null), null);
  assert.equal(polylineStart(undefined), null);
  assert.equal(polylineStart("redacted"), null, "a string that decodes to nowhere on Earth");
});

test("the export lists starred routes and activities since a time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-export-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    for (const f of fixtures) await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
    const starred = await db.all<{ id: string; name: string }>("SELECT id::VARCHAR AS id, name FROM route WHERE starred ORDER BY id");
    const unstarred = await db.all<{ id: string }>("SELECT id::VARCHAR AS id FROM route WHERE NOT starred");
    const all = await db.all<{ id: string; start_date: string }>(
      "SELECT id::VARCHAR AS id, start_date::VARCHAR AS start_date FROM activity WHERE deleted_at IS NULL ORDER BY start_date",
    );
    assert.ok(all.length >= 2, "fixtures hold several activities");

    const none = await syncExport(db, null);
    assert.equal(none.activities.length, 0, "no since, no activities");
    assert.deepEqual(none.starred_routes.map((r) => r.id).sort(), starred.map((r) => r.id).sort());
    for (const u of unstarred) assert.ok(!none.starred_routes.some((r) => r.id === u.id));
    assert.ok(none.route_list_checked_at === null || !Number.isNaN(Date.parse(none.route_list_checked_at)));
    for (const r of none.starred_routes) {
      assert.equal(typeof r.id, "string");
      if (r.start) assert.ok(Math.abs(r.start[0]) <= 90 && Math.abs(r.start[1]) <= 180);
    }

    const cut = new Date(all[all.length - 1]!.start_date);
    const recent = await syncExport(db, cut);
    assert.deepEqual(
      recent.activities.map((a) => a.id),
      all.filter((a) => new Date(a.start_date) >= cut).map((a) => a.id),
    );
    assert.ok(recent.activities.every((a) => typeof a.name === "string" && !Number.isNaN(Date.parse(a.start_date))));

    const gone = recent.activities[0]!.id;
    await db.run("UPDATE activity SET deleted_at = now() WHERE id = $1::BIGINT", [gone]);
    assert.ok(!(await syncExport(db, cut)).activities.some((a) => a.id === gone), "deleted activities are left out");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
