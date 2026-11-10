/** Modelled weather along a track: the conformance fixture shared with the curves app (SPEC.md, Weather), and the rest of the algorithm. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLimiter,
  fetchWeather,
  fillWeather,
  fmt4,
  limitScope,
  parseWeather,
  planPoints,
  RateLimited,
  type Track,
  WEATHER_BASES,
  WeatherCache,
  weatherRequests,
} from "../src/weather.js";

interface Case {
  name: string;
  entry: { start_time: string; indoor: boolean; manual: boolean };
  samples: { t: number[]; lat: number[]; lng: number[]; alt: (number | null)[] };
  now: string;
  exchanges: { url: string; status: number; body: unknown }[];
  weather: unknown;
}
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/weather-v1-fixture.json", import.meta.url), "utf8")) as {
  cases: Case[];
};

const res = (status: number, body: unknown, h: Record<string, string> = {}) =>
  ({
    ok: status < 400,
    status,
    json: async () => body,
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
  }) as unknown as Response;
const T0 = Date.UTC(2026, 10, 10, 12);
const noLimit = createLimiter(
  () => 0,
  async () => undefined,
);
/** a limiter on a clock that only moves when it sleeps */
const clocked = () => {
  let t = T0;
  const sleeps: number[] = [];
  const limiter = createLimiter(
    () => t,
    async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  );
  return { limiter, sleeps };
};
const trackOf = (s: Case["samples"]): Track => ({
  t: s.t,
  lat: s.lat,
  lng: s.lng,
  alt: s.alt[0] === null ? null : s.alt,
});

for (const c of FIXTURE.cases) {
  test(`fixture case ${c.name}`, async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(String(url));
      const e = c.exchanges.find((x) => x.url === String(url));
      if (!e) throw new Error(`unexpected request ${url}`);
      return res(e.status, e.body);
    }) as unknown as typeof fetch;
    const w = await fetchWeather(c.entry, trackOf(c.samples), { fetch: f, limiter: noLimit, now: () => c.now });
    assert.deepEqual(
      asked,
      c.exchanges.map((e) => e.url),
    );
    assert.deepEqual(w, c.weather);
  });
}

test("the fixture has the cases every implementation needs", () => {
  assert.deepEqual(
    FIXTURE.cases.map((c) => c.name),
    ["track", "no-altitude", "indoor", "no-position", "archive-fallback", "long"],
  );
});

test("points: the first, every 600 s, the last; none without a track", () => {
  const entry = { indoor: false, manual: false };
  const n = 1501;
  const t = Array.from({ length: n }, (_, i) => i);
  const lat = t.map(() => 450_000_000);
  const lng = t.map(() => -1_200_000_000);
  const alt = t.map(() => 100);
  assert.deepEqual(
    planPoints(entry, { t, lat, lng, alt }).map((p) => p.t),
    [0, 600, 1200, 1500],
  );
  assert.deepEqual(
    planPoints(entry, { t: t.slice(0, 1201), lat, lng, alt }).map((p) => p.t),
    [0, 600, 1200],
  );
  const two = { t: [0, 700], lat: [450_000_000, 450_000_000], lng: [-1_200_000_000, -1_200_000_000], alt: null };
  assert.deepEqual(planPoints({ indoor: true, manual: false }, two), []);
  assert.deepEqual(planPoints({ indoor: false, manual: true }, two), []);
  assert.deepEqual(planPoints(entry, { ...two, lat: [0, 0], lng: [0, 0] }), []);
  assert.deepEqual(planPoints(entry, { ...two, lat: [null, null], lng: [null, null] }), []);
  assert.deepEqual(planPoints(entry, { t: [5], lat: [450_000_000], lng: [-1_200_000_000], alt: null }), []);
  assert.deepEqual(
    planPoints(entry, two).map((p) => p.alt),
    [null, null],
  );
});

test("coordinates round half up in integers", () => {
  assert.equal(fmt4(450_000_000), "45.0000");
  assert.equal(fmt4(-1_200_000_000), "-120.0000");
  assert.equal(fmt4(10_312_500), "1.0313");
  assert.equal(fmt4(-10_312_500), "-1.0312");
  assert.equal(fmt4(-40), "0.0000");
  assert.equal(fmt4(-600), "-0.0001");
});

test("requests chunk at 50 and date the first and last point of each chunk", () => {
  const pts = Array.from({ length: 120 }, (_, i) => ({
    t: i * 600,
    lat: 450_000_000,
    lng: -1_200_000_000,
    alt: i % 2 ? 100.5 : null,
  }));
  const reqs = weatherRequests(pts, Date.parse("2024-07-15T23:00:00.000Z"), "archive");
  assert.deepEqual(
    reqs.map((r) => r.n),
    [50, 50, 20],
  );
  assert.ok(reqs[0]!.url.startsWith(`${WEATHER_BASES.archive}?latitude=45.0000,`));
  assert.ok(reqs[0]!.url.includes("&elevation=nan,101,nan,"));
  assert.ok(reqs[0]!.url.includes("&start_date=2024-07-15&end_date=2024-07-16"));
});

const body = (temp: (number | null)[], dir = [90, 180]) => ({
  elevation: 100,
  hourly: {
    time: [0, 3600],
    temperature_2m: temp,
    dew_point_2m: [0, 0],
    wind_speed_10m: [1, 2],
    wind_direction_10m: dir,
  },
});
const pt = { t: 0, lat: 450_000_000, lng: -1_200_000_000, alt: 100 };

test("parsing interpolates in time and takes the nearer hour for the direction", () => {
  const r = parseWeather([{ ...pt, t: 1000 }], 0, [body([10, 20])]);
  assert.deepEqual([r.temp, r.wind, r.wind_dir], [[12.8], [1.3], [90]]);
  assert.deepEqual(parseWeather([{ ...pt, t: 2000 }], 0, [body([10, 20])]).wind_dir, [180]);
  assert.deepEqual(parseWeather([{ ...pt, t: 1800 }], 0, [body([10, 20])]).wind_dir, [90]);
  assert.equal(parseWeather([pt], 0, [body([null, 20])]).count, 0);
  assert.equal(parseWeather([{ ...pt, t: 7200 }], 0, [body([10, 20])]).count, 0);
  assert.deepEqual(parseWeather([pt, { ...pt, t: 600 }], 0, [[body([10, 20]), body([30, 40])]]).temp, [10, 31.7]);
  assert.throws(() => parseWeather([pt], 0, [{}]));
});

test("a limit waits Retry-After once; a long one stops at once; other errors are errors", async () => {
  const c = FIXTURE.cases[0]!;
  const run = (f: typeof fetch, limiter = noLimit) =>
    fetchWeather(c.entry, trackOf(c.samples), { fetch: f, limiter, now: () => c.now });
  assert.deepEqual(
    [
      "Daily API request limit exceeded",
      "Hourly API request limit exceeded",
      "Minutely API request limit exceeded",
    ].map(limitScope),
    ["day", "hour", "minute"],
  );
  let calls = 0;
  const m = clocked();
  await assert.rejects(
    run(
      (async () => {
        calls++;
        return res(429, { error: true, reason: "Minutely API request limit exceeded" }, { "retry-after": "42" });
      }) as unknown as typeof fetch,
      m.limiter,
    ),
    (e) => e instanceof RateLimited && e.scope === "minute",
  );
  assert.equal(calls, 2);
  assert.deepEqual(m.sleeps, [43_001]);
  // without headers a minute is 60 s
  const n = clocked();
  await assert.rejects(
    run(
      (async () => res(429, { error: true, reason: "Minutely API request limit exceeded" })) as unknown as typeof fetch,
      n.limiter,
    ),
    RateLimited,
  );
  assert.deepEqual(n.sleeps, [60_001]);
  calls = 0;
  const ok = c.exchanges[0]!.body;
  const recovered = await run(
    (async () =>
      ++calls === 1
        ? res(429, { error: true, reason: "Minutely API request limit exceeded" }, { "retry-after": "5" })
        : res(200, ok)) as unknown as typeof fetch,
    clocked().limiter,
  );
  assert.deepEqual(recovered, c.weather);
  calls = 0;
  await assert.rejects(
    run(
      (async () => {
        calls++;
        return res(429, { error: true, reason: "Daily API request limit exceeded" }, { "retry-after": "9000" });
      }) as unknown as typeof fetch,
      clocked().limiter,
    ),
    (e) => e instanceof RateLimited && e.scope === "day" && e.until === T0 + 9_001_000,
  );
  assert.equal(calls, 1);
  await assert.rejects(run((async () => res(500, {})) as unknown as typeof fetch), /HTTP 500/);
  await assert.rejects(
    run((async () => res(200, { error: true, reason: "Cannot initialize" })) as unknown as typeof fetch),
    /Cannot initialize/,
  );
});

test("the limiter follows the headers: waits for a minute running low, stops for a day", async () => {
  const { limiter: lim, sleeps } = clocked();
  const h = (limit: number, remaining: number, reset: number) =>
    res(200, null, {
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(reset / 1000),
    });
  await lim.take(5);
  lim.observe(h(600, 300, T0 + 30_000));
  await lim.take(5);
  assert.deepEqual(sleeps, []);
  lim.observe(h(600, 50, T0 + 30_000));
  await lim.take(5);
  assert.deepEqual(sleeps, [31_001]);
  lim.observe(h(10_000, 900, T0 + 31_001 + 5 * 3_600_000));
  await assert.rejects(lim.take(5), (e) => e instanceof RateLimited && e.scope === "day");
  assert.equal(lim.total, 15);
  const free = createLimiter(() => T0);
  free.observe(res(200, null));
  for (let i = 0; i < 100; i++) await free.take(50);
  assert.equal(free.total, 5000);
});

// fill: the fixture's `track` body answers any request for up to its four points
const track = FIXTURE.cases[0]!;
const candidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `strava:${i}`,
    fingerprint: `f${i}`,
    start_time: `2024-07-15T18:00:${String(i).padStart(2, "0")}.000Z`,
    indoor: false,
    manual: false,
  }));
const serve = () => {
  let calls = 0;
  const f = (async (url: string) => {
    calls++;
    const n = url.split("latitude=")[1]!.split("&")[0]!.split(",").length;
    const b = track.exchanges[0]!.body as unknown[];
    return res(200, n === b.length ? b : Array.from({ length: n }, () => b[0]));
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
};
const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "strava-weather-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const read = async () => trackOf(track.samples);

test("fill fetches newest first and remembers", () =>
  withDir(async (dir) => {
    const cache = new WeatherCache(join(dir, "w.json"));
    const seen: string[] = [];
    const s = serve();
    const stats = await fillWeather(
      cache,
      candidates(3),
      async (id) => {
        seen.push(id);
        return read();
      },
      s.f,
      {
        maxCalls: 1000,
      },
    );
    assert.deepEqual(stats, { fetched: 3, none: 0, failed: 0 });
    assert.deepEqual(seen, ["strava:2", "strava:1", "strava:0"]);
    const again = new WeatherCache(join(dir, "w.json"));
    assert.equal(again.weather("strava:1", "f1")?.version, 1);
    assert.equal(again.weather("strava:1", "other"), null);
    const before = s.calls();
    assert.deepEqual(await fillWeather(again, candidates(3), read, s.f), { fetched: 0, none: 0, failed: 0 });
    assert.equal(s.calls(), before);
  }));

test("fill skips indoor and manual, remembers none for 30 days, and keeps to its budget", () =>
  withDir(async (dir) => {
    const cs = candidates(3);
    cs[0]!.indoor = true;
    cs[1]!.manual = true;
    const s = serve();
    assert.equal((await fillWeather(new WeatherCache(join(dir, "a.json")), cs, read, s.f)).fetched, 1);
    const empty = async (): Promise<Track> => ({ t: [0, 1], lat: [null, null], lng: [null, null], alt: null });
    const cache = new WeatherCache(join(dir, "b.json"));
    assert.deepEqual(await fillWeather(cache, candidates(1), empty, s.f), { fetched: 0, none: 1, failed: 0 });
    assert.equal((await fillWeather(cache, candidates(1), empty, s.f)).none, 0);
    cache.data.entries["strava:0"]!.tried_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
    assert.equal((await fillWeather(cache, candidates(1), empty, s.f)).none, 1);
    assert.equal(
      (await fillWeather(new WeatherCache(join(dir, "c.json")), candidates(5), read, s.f, { maxCalls: 8 })).fetched,
      2,
    );
  }));

test("fill pauses after a daily limit and survives an activity that fails", () =>
  withDir(async (dir) => {
    let calls = 0;
    const daily = (async () => {
      calls++;
      return res(429, { error: true, reason: "Daily API request limit exceeded" });
    }) as unknown as typeof fetch;
    const cache = new WeatherCache(join(dir, "a.json"));
    assert.deepEqual(await fillWeather(cache, candidates(3), read, daily), { fetched: 0, none: 0, failed: 0 });
    assert.equal(calls, 1);
    assert.ok(cache.data.retry_after);
    await fillWeather(new WeatherCache(join(dir, "a.json")), candidates(3), read, daily);
    assert.equal(calls, 1);
    const stats = await fillWeather(
      new WeatherCache(join(dir, "b.json")),
      candidates(3),
      async (id) => {
        if (id === "strava:2") throw new Error("unreadable");
        return read();
      },
      serve().f,
    );
    assert.deepEqual(stats, { fetched: 2, none: 0, failed: 1 });
  }));
