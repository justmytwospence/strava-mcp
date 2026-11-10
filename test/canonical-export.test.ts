/** The canonical export: files, manifest and HTTP route, from fixtures and synthetic streams. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { CanonicalExporter, type ExporterOptions, tagsOf } from "../src/canonical.js";
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

/** Open-Meteo for any request: 15 degrees C everywhere, from the query's dates and locations (or a failure). */
function meteo(status = 200, reason = "") {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (status !== 200) return new Response(JSON.stringify({ error: true, reason }), { status });
    const q = new URL(url).searchParams;
    const t0 = Date.parse(`${q.get("start_date")}T00:00:00Z`) / 1000;
    const t1 = Date.parse(`${q.get("end_date")}T23:00:00Z`) / 1000;
    const time: number[] = [];
    for (let t = t0; t <= t1; t += 3600) time.push(t);
    const fill = (v: number) => time.map(() => v);
    const loc = {
      elevation: 1234,
      hourly: {
        time,
        temperature_2m: fill(15),
        dew_point_2m: fill(7),
        wind_speed_10m: fill(3),
        wind_direction_10m: fill(270),
      },
    };
    const n = q.get("latitude")!.split(",").length;
    return new Response(JSON.stringify(n === 1 ? loc : Array.from({ length: n }, () => loc)));
  }) as typeof fetch;
  return { f, urls };
}

async function withSnapshot(fn: (dir: string, path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "strava-canon-wx-"));
  const db = await Database.open({ path: join(dir, "strava.duckdb"), snapshotDir: join(dir, "snapshot") });
  try {
    for (const f of fixtures) await db.transaction((tx) => land(tx, f.type, f.key, JSON.stringify(f.body)));
    await db.transaction((tx) => land(tx, "activity_streams", "1001", streams(20)));
    await db.transaction((tx) => land(tx, "activity_streams", "1005", streams(20)));
    const pub = new SnapshotPublisher(db);
    await pub.publish();
    await fn(dir, pub.path);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const exporterIn = (dir: string, opts: Partial<ExporterOptions>) =>
  new CanonicalExporter(join(dir, "export", "canonical-v1"), "strava-mcp-export@test", {
    memoryLimit: "256MB",
    batch: 200,
    ...opts,
  });
const manifestOf = (exp: CanonicalExporter) => JSON.parse(readFileSync(exp.manifestPath, "utf8"));

test("export carries modelled weather, from a sidecar cache it does not ask again", () =>
  withSnapshot(async (dir, path) => {
    const m = meteo();
    const exp = exporterIn(dir, { weather: true, weatherFetch: m.f });
    await exp.run(path);
    const entries = manifestOf(exp).activities as Array<{ id: string; weather: Record<string, unknown[]> | null }>;
    const run = entries.find((e) => e.id === "strava:1001")!;
    assert.equal(run.weather?.version, 1);
    assert.equal(run.weather?.source, "open-meteo");
    assert.equal(run.weather?.api, "historical-forecast");
    assert.equal(run.weather?.t[0], 0);
    assert.equal(run.weather?.temp[0], 15);
    assert.ok((run.weather?.t.length ?? 0) >= 2);
    assert.ok(m.urls[0]!.includes("latitude=40.1235"), "positions as 4-decimal degrees");
    assert.ok(existsSync(join(dir, "export", "weather-v1.json")), "a sidecar, beside the export");
    assert.ok(!existsSync(join(exp.outDir, "weather-v1.json")));
    const asked = m.urls.length;
    await exp.run(path);
    assert.equal(m.urls.length, asked);
    await exporterIn(dir, { weather: true, weatherFetch: m.f }).run(path);
    assert.equal(m.urls.length, asked, "a restart reads the same cache");
  }));

test("export weather off is null", () =>
  withSnapshot(async (dir, path) => {
    const exp = exporterIn(dir, {});
    await exp.run(path);
    for (const e of manifestOf(exp).activities) assert.equal(e.weather, null);
    assert.ok(!existsSync(join(dir, "export", "weather-v1.json")));
  }));

test("a weather limit or failure does not fail the export, and a daily limit pauses it", () =>
  withSnapshot(async (dir, path) => {
    const daily = meteo(429, "Daily API request limit exceeded");
    const exp = exporterIn(dir, { weather: true, weatherFetch: daily.f });
    await exp.run(path);
    for (const e of manifestOf(exp).activities) assert.equal(e.weather, null);
    assert.equal(daily.urls.length, 1);
    await exp.run(path);
    assert.equal(daily.urls.length, 1, "paused until the next UTC day");
    const dir2 = join(dir, "second");
    const boom = exporterIn(dir2, {
      weather: true,
      weatherFetch: (async () => {
        throw new Error("no network");
      }) as unknown as typeof fetch,
    });
    await boom.run(path);
    for (const e of manifestOf(boom).activities) assert.equal(e.weather, null);
  }));
