/** The canonical export: files, manifest and HTTP route, from fixtures and synthetic streams. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { CanonicalExporter, tagsOf } from "../src/canonical.js";
import { Database } from "../src/db/database.js";
import { land } from "../src/db/raw.js";
import { createHttpApp } from "../src/http.js";
import { SnapshotPublisher } from "../src/snapshot.js";

const fixtures: Array<{ type: string; key: string; body: unknown }> = JSON.parse(
  readFileSync(new URL("./fixtures/payloads.json", import.meta.url), "utf8"),
);

function streams(n: number, withDup = false): string {
  const series = (f: (i: number) => unknown) => ({
    data: Array.from({ length: n }, (_, i) => f(i)),
    series_type: "distance",
    original_size: n,
    resolution: "high",
  });
  return JSON.stringify({
    time: series((i) => (withDup && i === 3 ? 2 : i) + 10),
    distance: series((i) => (withDup && i === 3 ? 1 : i * 2.5)),
    latlng: series((i) => [40.1234567 + i * 1e-5, -105.1234567]),
    altitude: series((i) => 1600 + i),
    heartrate: series((i) => 110 + i),
    cadence: series(() => 85),
    watts: series(() => 200),
  });
}

test("workout types become canonical tags", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 10, 11, 12, 31, null].map((w) => tagsOf(w)),
    [[], ["race"], ["long_run"], ["workout"], [], ["race"], ["workout"], [], []],
  );
});

test("export writes per-second files, a manifest, and only what changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-canon-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    for (const f of fixtures) await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
    // 1001 TrailRun (device_watts true), 1005 Ride, 1013 manual Yoga (no streams), 1009 has fixture streams
    await db.transaction((tx) => land(tx, "activity_streams", "1001", streams(20, true)));
    await db.transaction((tx) => land(tx, "activity_streams", "1005", streams(20)));
    await db.run("UPDATE activity SET device_watts = false WHERE id = 1005");
    await db.run("UPDATE activity SET workout_type = 1 WHERE id = 1001");
    const pub = new SnapshotPublisher(db);
    await pub.publish();
    const exp = new CanonicalExporter(join(dir, "export", "canonical-v1"), "strava-mcp-export@test");
    const r1 = await exp.run(pub.path);
    assert.equal(r1.activities, 3);
    const m = JSON.parse(readFileSync(exp.manifestPath, "utf8"));
    assert.equal(m.schema_version, 1);
    assert.deepEqual(m.activities.map((a: { id: string }) => a.id).sort(), [
      "strava:1001",
      "strava:1005",
      "strava:1009",
    ]);
    const run = m.activities.find((a: { id: string }) => a.id === "strava:1001");
    assert.equal(run.sport, "trail_run");
    assert.equal(run.cadence_unit, "cycles");
    assert.deepEqual(run.tags, ["race"]);
    assert.deepEqual(m.activities.find((a: { id: string }) => a.id === "strava:1005").tags, []);
    assert.equal(run.n, 19, "the duplicate second collapsed");
    assert.ok(run.fingerprint.includes("|strava-api/1001-"));
    assert.match(run.start_time, /Z$/);
    assert.ok(existsSync(join(exp.outDir, run.file)));

    const q = await DuckDBInstance.create(":memory:");
    const c = await q.connect();
    const rows = async (id: string) =>
      (
        await c.runAndReadAll(
          `SELECT * FROM read_parquet('${join(exp.outDir, `activities/strava-${id}.parquet`)}') ORDER BY t`,
        )
      ).getRowObjectsJson() as Record<string, unknown>[];
    const a = await rows("1001");
    assert.equal(Number(a[0]!.t), 0);
    assert.ok(Number.isInteger(Number(a[0]!.lat)) && Number.isInteger(Number(a[0]!.lng)));
    assert.equal(Number(a[0]!.lat), 401234567);
    assert.equal(Number(a[2]!.dist), 5, "the greater distance wins at a duplicate second");
    assert.equal(Number(a[0]!.power), 200);
    const b = await rows("1005");
    assert.equal(b[0]!.power, null, "estimated power is not exported");
    c.closeSync();
    q.closeSync();

    const r2 = await exp.run(pub.path);
    assert.equal(r2.written, 0);
    const m2 = JSON.parse(readFileSync(exp.manifestPath, "utf8"));
    assert.equal(m2.activities[0].updated_at, m.activities[0].updated_at);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the export route: disabled, unauthorized, served, and CORS only for listed origins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-canon-http-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    const exp = new CanonicalExporter(join(dir, "export", "canonical-v1"), "t");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(exp.outDir, { recursive: true });
    writeFileSync(exp.manifestPath, '{"schema_version":1,"activities":[]}');
    const mk = (exporter: CanonicalExporter | null, token: string) =>
      createHttpApp({
        handler: { fetch: async () => new Response("x") } as never,
        db,
        snapshot: new SnapshotPublisher(db),
        webhook: null,
        allowedHosts: [],
        mcpToken: "m",
        snapshotToken: "s",
        exporter,
        exportToken: token,
        exportCorsOrigins: ["https://effortcurve.com"],
      });
    const url = "http://localhost/export/canonical/v1/manifest.json";
    assert.equal((await mk(null, "").request(url)).status, 404);
    const app = mk(exp, "tok");
    assert.equal((await app.request(url)).status, 401);
    const ok = await app.request(url, { headers: { authorization: "Bearer tok", origin: "https://effortcurve.com" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://effortcurve.com");
    const other = await app.request(url, { headers: { authorization: "Bearer tok", origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const pre = await app.request(url, {
      method: "OPTIONS",
      headers: {
        origin: "https://effortcurve.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true",
      },
    });
    assert.ok(pre.status === 204 || pre.status === 200);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://effortcurve.com");
    assert.equal(pre.headers.get("access-control-allow-private-network"), "true");
    const bad = await app.request("http://localhost/export/canonical/v1/activities/x.parquet", {
      headers: { authorization: "Bearer tok" },
    });
    assert.equal(bad.status, 404);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
