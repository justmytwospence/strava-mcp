/**
 * Modelled weather along an activity's track, for the canonical export (`weather` in each manifest entry).
 *
 * Open-Meteo values at points about ten minutes apart, each asked for at the recorded altitude: version 1 of the curves
 * app's canonical-schema algorithm (SPEC.md, "Weather"), pinned case by case by test/fixtures/weather-v1-fixture.json.
 * Pure apart from the requests (through an injectable fetch) and the `WeatherCache` file.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const WEATHER_VERSION = 1;
export const WEATHER_BASES = {
  "historical-forecast": "https://historical-forecast-api.open-meteo.com/v1/forecast",
  archive: "https://archive-api.open-meteo.com/v1/archive",
} as const;
export type WeatherApi = keyof typeof WEATHER_BASES;
export type WeatherBases = Record<WeatherApi, string>;

export const STEP_S = 600;
export const CHUNK = 50;
/** Open-Meteo reports how much of each window is left (X-RateLimit-*); a pause starts when less than this share remains */
export const HEADROOM = 0.1;
/** a pause up to this long is waited out in place; a longer one stops the run */
export const MAX_WAIT_MS = 120_000;
const NONE_DAYS = 30;
const HOURLY = "temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m";

export interface Weather {
  version: number;
  source: "open-meteo";
  api: WeatherApi;
  fetched_at: string;
  t: number[];
  elev: number[];
  temp: number[];
  dew: (number | null)[];
  wind: (number | null)[];
  wind_dir: (number | null)[];
}

/** An activity's track: seconds from the first record, position in degrees x 1e7, altitude in m (null = unknown). */
export interface Track {
  t: number[];
  lat: (number | null)[];
  lng: (number | null)[];
  alt: (number | null)[] | null;
}

/** seconds from the start, position in degrees x 1e7, altitude in m (null when unknown) */
export interface Point {
  t: number;
  lat: number;
  lng: number;
  alt: number | null;
}

export class WeatherFormatError extends Error {}

/** Open-Meteo said slow down (or is about to): `scope` is the window that ran out, `until` when to try again (ms since the epoch). */
export class RateLimited extends Error {
  constructor(
    readonly scope: "minute" | "hour" | "day",
    message = `Open-Meteo rate limit (${scope})`,
    readonly until?: number,
  ) {
    super(message);
  }
}

export function limitScope(reason: string): "minute" | "hour" | "day" {
  return /daily/i.test(reason) ? "day" : /hourly/i.test(reason) ? "hour" : "minute";
}

/** Steps 1 and 2: the points to ask about; an empty array means "no weather". */
export function planPoints(entry: { indoor: boolean; manual: boolean }, s: Track): Point[] {
  if (entry.indoor || entry.manual) return [];
  const rows: number[] = [];
  for (let i = 0; i < s.t.length; i++) {
    const la = s.lat[i];
    const ln = s.lng[i];
    if (la != null && ln != null && (la !== 0 || ln !== 0)) rows.push(i);
  }
  if (rows.length < 2) return [];
  const pt = (i: number): Point => {
    const a = s.alt ? s.alt[i] : null;
    return { t: s.t[i]!, lat: s.lat[i]!, lng: s.lng[i]!, alt: a != null && Number.isFinite(a) ? a : null };
  };
  const out: Point[] = [pt(rows[0]!)];
  for (const i of rows) if (s.t[i]! >= out[out.length - 1]!.t + STEP_S) out.push(pt(i));
  const last = rows[rows.length - 1]!;
  if (s.t[last]! > out[out.length - 1]!.t) out.push(pt(last));
  return out;
}

/** degrees x 1e7 as degrees with exactly 4 decimals, rounded half up by integer arithmetic (the same in every language) */
export function fmt4(e7: number): string {
  const n = Math.floor((e7 + 500) / 1000);
  const a = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(a / 10000)}.${String(a % 10000).padStart(4, "0")}`;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Steps 3 and 4: the requests, in order; `n` is the number of locations in each. */
export function weatherRequests(
  points: Point[],
  startMs: number,
  api: WeatherApi,
  bases: WeatherBases = WEATHER_BASES,
): { url: string; n: number }[] {
  const out: { url: string; n: number }[] = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const ch = points.slice(i, i + CHUNK);
    const lat = ch.map((p) => fmt4(p.lat)).join(",");
    const lng = ch.map((p) => fmt4(p.lng)).join(",");
    const elev = ch.map((p) => (p.alt === null ? "nan" : String(Math.floor(p.alt + 0.5)))).join(",");
    const d0 = day(startMs + ch[0]!.t * 1000);
    const d1 = day(startMs + (ch[ch.length - 1]!.t + 3600) * 1000);
    out.push({
      url:
        `${bases[api]}?latitude=${lat}&longitude=${lng}&elevation=${elev}&hourly=${HOURLY}` +
        `&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&start_date=${d0}&end_date=${d1}`,
      n: ch.length,
    });
  }
  return out;
}

type Hourly = { time: number[]; [k: string]: (number | null)[] };

function lerpAt(h: Hourly, key: string, T: number): number | null {
  const v = h[key];
  if (!v) return null;
  for (let j = 0; j + 1 < h.time.length; j++) {
    const t0 = h.time[j]!;
    const t1 = h.time[j + 1]!;
    if (t0 <= T && T <= t1) {
      const a = v[j];
      const b = v[j + 1];
      if (a == null || b == null) return null;
      const f = (T - t0) / (t1 - t0);
      return a + (b - a) * f;
    }
  }
  return null;
}

function nearAt(h: Hourly, key: string, T: number): number | null {
  const v = h[key];
  if (!v) return null;
  for (let j = 0; j + 1 < h.time.length; j++) {
    const t0 = h.time[j]!;
    const t1 = h.time[j + 1]!;
    if (t0 <= T && T <= t1) return v[T - t0 <= t1 - T ? j : j + 1] ?? null;
  }
  return null;
}

const r1 = (x: number) => Math.floor(x * 10 + 0.5) / 10;

export type Parsed = Omit<Weather, "version" | "source" | "api" | "fetched_at"> & { count: number };

/** Steps 5 and 6: the kept points from the responses (one per request, an object or an array of locations). */
export function parseWeather(points: Point[], startMs: number, bodies: unknown[]): Parsed {
  const locs = bodies.flatMap((b) => (Array.isArray(b) ? b : [b])) as { hourly?: Hourly; elevation?: number }[];
  if (locs.length !== points.length)
    throw new WeatherFormatError(`${locs.length} locations for ${points.length} points`);
  const out: Parsed = { t: [], elev: [], temp: [], dew: [], wind: [], wind_dir: [], count: 0 };
  points.forEach((p, i) => {
    const loc = locs[i];
    const h = loc?.hourly;
    if (!h || !Array.isArray(h.time)) throw new WeatherFormatError("a response without hourly.time");
    const T = startMs / 1000 + p.t;
    const temp = lerpAt(h, "temperature_2m", T);
    const elev =
      p.alt !== null
        ? Math.floor(p.alt + 0.5)
        : typeof loc?.elevation === "number"
          ? Math.floor(loc.elevation + 0.5)
          : null;
    if (temp === null || elev === null) return;
    const dew = lerpAt(h, "dew_point_2m", T);
    const wind = lerpAt(h, "wind_speed_10m", T);
    const dir = nearAt(h, "wind_direction_10m", T);
    out.t.push(p.t);
    out.elev.push(elev);
    out.temp.push(r1(temp));
    out.dew.push(dew === null ? null : r1(dew));
    out.wind.push(wind === null ? null : r1(wind));
    out.wind_dir.push(dir === null ? null : Math.floor(dir + 0.5));
    out.count++;
  });
  return out;
}

/** Learns Open-Meteo's limits from its responses and keeps the run inside them, whoever else shares the IP address. */
export interface Limiter {
  /** before a request of `n` locations: waits out a short pause, throws RateLimited for a long one */
  take(n: number): Promise<void>;
  /** after a response: the headers say how much of the tightest window is left and when it resets */
  observe(res: Response): void;
  /** Open-Meteo refused (429, or an error body): pause for Retry-After, else for the scope's window */
  hit(res: Response | null, scope: "minute" | "hour" | "day"): void;
  /** calls taken through this limiter */
  total: number;
  /** when the current pause ends (ms since the epoch), 0 for none */
  until(): number;
  /** how much of the pause is left, in ms */
  pauseMs(): number;
}
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const header = (res: Response | null, k: string): number | null => {
  const v = res?.headers?.get?.(k);
  const n = v == null ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
const scopeOf = (ms: number): "minute" | "hour" | "day" =>
  ms <= MAX_WAIT_MS ? "minute" : ms <= 3_600_000 ? "hour" : "day";

export function createLimiter(now: () => number = Date.now, sleep: (ms: number) => Promise<void> = sleepMs): Limiter {
  let until = 0;
  const lim: Limiter = {
    total: 0,
    until: () => until,
    pauseMs: () => Math.max(0, until - now()),
    async take(n) {
      for (;;) {
        const wait = until - now();
        if (wait <= 0) break;
        if (wait > MAX_WAIT_MS) throw new RateLimited(scopeOf(wait), "Open-Meteo asked for a pause", until);
        await sleep(wait + 1);
      }
      lim.total += n;
    },
    observe(res) {
      const remaining = header(res, "x-ratelimit-remaining");
      const limit = header(res, "x-ratelimit-limit");
      const reset = header(res, "x-ratelimit-reset");
      if (remaining !== null && limit && reset !== null && remaining < limit * HEADROOM) {
        until = Math.max(until, reset * 1000 + 1000);
      }
    },
    hit(res, scope) {
      const t = now();
      const retry = header(res, "retry-after");
      const fallback = scope === "day" ? nextDay(t) : scope === "hour" ? nextHour(t) : t + 60_000;
      until = Math.max(until, retry !== null ? t + (retry + 1) * 1000 : fallback);
    },
  };
  return lim;
}

export interface FetchOpts {
  fetch: typeof fetch;
  limiter: Limiter;
  now?: () => string;
  bases?: WeatherBases;
}

async function getJson(url: string, n: number, o: FetchOpts): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await o.limiter.take(n);
    const res = await o.fetch(url);
    o.limiter.observe(res);
    let body: unknown = null;
    let limited: RateLimited | null = null;
    if (res.status === 429) {
      let reason = "";
      try {
        reason = String(((await res.json()) as { reason?: string }).reason ?? "");
      } catch {
        // an empty body
      }
      limited = new RateLimited(limitScope(reason), reason || "HTTP 429");
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      body = await res.json();
      const b = body as { error?: boolean; reason?: string } | null;
      if (b && !Array.isArray(b) && b.error === true) {
        if (/limit/i.test(String(b.reason))) limited = new RateLimited(limitScope(String(b.reason)), String(b.reason));
        else throw new Error(String(b.reason ?? "Open-Meteo error"));
      }
    }
    if (!limited) return body;
    o.limiter.hit(res, limited.scope);
    if (attempt >= 1 || o.limiter.pauseMs() > MAX_WAIT_MS)
      throw new RateLimited(limited.scope, limited.message, o.limiter.until());
  }
}

async function attempt(points: Point[], startMs: number, api: WeatherApi, o: FetchOpts): Promise<Parsed> {
  const bodies: unknown[] = [];
  for (const r of weatherRequests(points, startMs, api, o.bases)) bodies.push(await getJson(r.url, r.n, o));
  return parseWeather(points, startMs, bodies);
}

/** Steps 1 to 8: the activity's weather, or null when it has none (indoor, no track, nothing from the model). */
export async function fetchWeather(
  entry: { start_time: string; indoor: boolean; manual: boolean },
  s: Track,
  opts: FetchOpts,
): Promise<Weather | null> {
  const points = planPoints(entry, s);
  if (!points.length) return null;
  const startMs = Date.parse(entry.start_time);
  let api: WeatherApi = "historical-forecast";
  let best = await attempt(points, startMs, api, opts);
  if (best.count * 2 < points.length) {
    const alt = await attempt(points, startMs, "archive", opts);
    if (alt.count > best.count) {
      best = alt;
      api = "archive";
    }
  }
  if (!best.count) return null;
  const { count: _count, ...arrays } = best;
  return {
    version: WEATHER_VERSION,
    source: "open-meteo",
    api,
    fetched_at: (opts.now ?? (() => new Date().toISOString()))(),
    ...arrays,
  };
}

interface CacheEntry {
  fingerprint: string;
  weather: Weather | null;
  tried_at: string;
}
interface CacheData {
  version: 1;
  retry_after: string | null;
  entries: Record<string, CacheEntry>;
}

/** `weather-v1.json` beside the export: per activity the weather found for a given fingerprint (or null, with when it was
 * tried) and a pause after Open-Meteo's limits. A sidecar file, never served. */
export class WeatherCache {
  data: CacheData = { version: 1, retry_after: null, entries: {} };

  constructor(readonly path: string) {
    if (existsSync(path)) {
      try {
        const d = JSON.parse(readFileSync(path, "utf8")) as CacheData;
        if (d && d.version === 1) this.data = { ...this.data, ...d };
      } catch {
        // an unreadable cache is a fresh one
      }
    }
  }

  save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }

  weather(id: string, fingerprint: string): Weather | null {
    const e = this.data.entries[id];
    return e && e.fingerprint === fingerprint ? e.weather : null;
  }

  done(id: string, fingerprint: string, now: number): boolean {
    const e = this.data.entries[id];
    if (!e || e.fingerprint !== fingerprint) return false;
    if (e.weather !== null) return true;
    return now - Date.parse(e.tried_at) < NONE_DAYS * 86_400_000;
  }

  forget(keep: Set<string>): void {
    for (const k of Object.keys(this.data.entries)) if (!keep.has(k)) delete this.data.entries[k];
  }
}

export interface Candidate {
  id: string;
  fingerprint: string;
  start_time: string;
  indoor: boolean;
  manual: boolean;
}

export interface FillOpts {
  maxCalls?: number;
  maxSeconds?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  bases?: WeatherBases;
  log?: (msg: string) => void;
}

const nextHour = (t: number) => Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000;
const nextDay = (t: number) => Math.floor(t / 86_400_000) * 86_400_000 + 86_400_000;

/**
 * Fetch weather for the candidates that need it, newest first, within a budget; never throws for a weather problem.
 * The cache is saved every 25 activities and at the end.
 */
export async function fillWeather(
  cache: WeatherCache,
  candidates: Candidate[],
  readTrack: (id: string) => Promise<Track>,
  f: typeof fetch,
  o: FillOpts = {},
): Promise<{ fetched: number; none: number; failed: number }> {
  const stats = { fetched: 0, none: 0, failed: 0 };
  const now = o.now ?? Date.now;
  const retry = cache.data.retry_after;
  if (retry && now() < Date.parse(retry)) return stats;
  const limiter = createLimiter(now, o.sleep);
  const todo = candidates
    .filter((c) => !c.indoor && !c.manual && !cache.done(c.id, c.fingerprint, now()))
    .sort((a, b) => (a.start_time < b.start_time ? 1 : a.start_time > b.start_time ? -1 : 0));
  const began = now();
  let sinceSave = 0;
  let failures = 0;
  try {
    for (const c of todo) {
      if (limiter.total >= (o.maxCalls ?? 2000) || now() - began > (o.maxSeconds ?? 300) * 1000) break;
      let w: Weather | null;
      try {
        const track = await readTrack(c.id);
        w = await fetchWeather(c, track, {
          fetch: f,
          limiter,
          now: () => new Date(now()).toISOString(),
          bases: o.bases,
        });
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        o.log?.(`weather: ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        stats.failed++;
        if (++failures >= 5) break;
        continue;
      }
      failures = 0;
      cache.data.entries[c.id] = { fingerprint: c.fingerprint, weather: w, tried_at: new Date(now()).toISOString() };
      stats[w === null ? "none" : "fetched"]++;
      if (++sinceSave >= 25) {
        cache.save();
        sinceSave = 0;
      }
    }
    if (cache.data.retry_after) cache.data.retry_after = null;
  } catch (e) {
    if (!(e instanceof RateLimited)) throw e;
    const t = now();
    const until = e.until ?? (e.scope === "day" ? nextDay(t) : e.scope === "hour" ? nextHour(t) : t + 60_000);
    cache.data.retry_after = new Date(until).toISOString();
    o.log?.(`weather: Open-Meteo limit (${e.scope}), pausing until ${cache.data.retry_after}`);
  } finally {
    cache.save();
  }
  return stats;
}
