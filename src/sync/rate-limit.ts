/**
 * Strava rate limits, driven by the headers Strava returns on every counted request.
 *
 * Two limit pairs apply: overall (X-RateLimit-*) and non-upload reads
 * (X-ReadRateLimit-*), each "15-minute,daily". The 15-minute windows reset at :00,
 * :15, :30 and :45 UTC, the daily window at 00:00 UTC. Usage is only known from the
 * last response, so it is carried forward and reset at window boundaries.
 *
 * Each priority may use only part of a window, so background sync can never starve a
 * person asking a question. Backfill also spreads what it may use evenly over the rest
 * of the window instead of bursting. Missing headers are unknown accounting, never
 * evidence of a free endpoint. Every attempt reserves known pools locally; estimates
 * and authoritative header observations are kept separate.
 */

import { DAY, MINUTE, SECOND } from "../time.js";

export type Priority = "interactive" | "incremental" | "backfill";

/** Share of each limit a priority may consume: [15-minute, daily]. */
const SHARE: Record<Priority, [number, number]> = {
  interactive: [0.98, 0.995],
  incremental: [0.85, 0.9],
  backfill: [0.75, 0.75],
};

const FIFTEEN_MIN = 15 * MINUTE;
/** Conservative pacing while a required pool has no known allowance. */
const UNKNOWN_SPACING_MS = SECOND;

export interface Usage {
  usage15: number;
  usageDay: number;
  limit15: number;
  limitDay: number;
  observedAt: number;
}

export interface RateSample {
  observedAt: Date;
  method: string;
  path: string;
  status: number;
  priority: Priority;
  overall: Usage | null;
  read: Usage | null;
}

function parsePair(value: string | null): [number, number] | null {
  if (!value) return null;
  if (!/^\s*\d+\s*,\s*\d+\s*$/.test(value)) return null;
  const [a, b] = value.split(",").map(Number);
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) ? [a!, b!] : null;
}

function parseUsage(limit: string | null, usage: string | null, at: number): Usage | null {
  const l = parsePair(limit);
  const u = parsePair(usage);
  if (!l || !u || l[0] <= 0 || l[1] <= 0) return null;
  return { limit15: l[0], limitDay: l[1], usage15: u[0], usageDay: u[1], observedAt: at };
}

export function windowStart15(t: number): number {
  return Math.floor(t / FIFTEEN_MIN) * FIFTEEN_MIN;
}

export function dayStart(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** Usage carried forward to `now`: counters reset when their window has rolled over. */
export function currentUsage(u: Usage, now: number): Usage {
  return {
    ...u,
    usage15: windowStart15(u.observedAt) === windowStart15(now) ? u.usage15 : 0,
    usageDay: dayStart(u.observedAt) === dayStart(now) ? u.usageDay : 0,
  };
}

/** Normalize a path to its shape, e.g. /activities/123/streams -> /activities/{id}/streams. */
export function pathShape(path: string): string {
  return path.split("?")[0]!.replace(/\/(?:\d+|[bg]\d+)(?=\/|$)/g, "/{id}");
}

export class RateLimiter {
  overall: Usage | null = null;
  read: Usage | null = null;
  /** No request of any priority before this time (after a 429). */
  blockedUntil = 0;
  private lastStart: Record<Priority, number> = { interactive: -Infinity, incremental: -Infinity, backfill: -Infinity };
  private unknownPaths = new Set<string>();
  private estimatedOverall: Usage | null = null;
  private estimatedRead: Usage | null = null;
  private attempts = { overall: 0, read: 0 };
  private listeners: Array<(s: RateSample) => void> = [];

  constructor(private readonly now: () => number = Date.now) {}

  onSample(fn: (s: RateSample) => void): void {
    this.listeners.push(fn);
  }

  /** Seed from the last persisted sample, so a restart does not forget today's usage. */
  restore(overall: Usage | null, read: Usage | null): void {
    this.overall = overall;
    this.read = read;
    this.estimatedOverall = overall && { ...overall };
    this.estimatedRead = read && { ...read };
  }

  /** Retained for callers: no path is exempt merely because its headers are missing. */
  isCounted(_path: string): boolean {
    return true;
  }

  private reconcile(previous: Usage | null, sample: Usage): Usage {
    const before = previous && currentUsage(previous, sample.observedAt);
    return {
      ...sample,
      usage15: Math.max(sample.usage15, before?.usage15 ?? 0),
      usageDay: Math.max(sample.usageDay, before?.usageDay ?? 0),
    };
  }

  observe(method: string, path: string, status: number, headers: Headers, priority: Priority): void {
    const at = this.now();
    const overall = parseUsage(headers.get("x-ratelimit-limit"), headers.get("x-ratelimit-usage"), at);
    const read = parseUsage(headers.get("x-readratelimit-limit"), headers.get("x-readratelimit-usage"), at);
    if (overall) {
      this.overall = overall;
      this.estimatedOverall = this.reconcile(this.estimatedOverall, overall);
    }
    if (read) {
      this.read = read;
      this.estimatedRead = this.reconcile(this.estimatedRead, read);
    }
    const shape = `${method} ${pathShape(path)}`;
    if (!overall || (method === "GET" && !read)) this.unknownPaths.add(shape);
    else this.unknownPaths.delete(shape);
    if (status === 429) {
      const retry = headers.get("retry-after");
      const retryAt = retry && /^\d+(\.\d+)?$/.test(retry) ? at + Number(retry) * SECOND : Date.parse(retry ?? "");
      this.blockedUntil = Math.max(this.blockedUntil, this.next429Release(at), Number.isFinite(retryAt) ? retryAt : 0);
    }
    for (const fn of this.listeners) fn({ observedAt: new Date(at), method, path, status, priority, overall, read });
  }

  /** On a 429, wait for the next 15-minute boundary, or midnight UTC if a daily limit is spent. */
  private next429Release(at: number): number {
    const spentDaily = [this.estimatedOverall, this.estimatedRead].some(
      (u) => u && currentUsage(u, at).usageDay >= u.limitDay,
    );
    return spentDaily ? dayStart(at) + DAY : windowStart15(at) + FIFTEEN_MIN;
  }

  /** Milliseconds until a request of this priority may start (0 = now). */
  delayFor(priority: Priority, method: string, _path: string): number {
    const now = this.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;
    const [share15, shareDay] = SHARE[priority];
    const pools = [this.estimatedOverall, ...(method === "GET" ? [this.estimatedRead] : [])];
    let wait = pools.some((u) => !u) ? this.lastStart[priority] + UNKNOWN_SPACING_MS - now : 0;
    for (const raw of pools) {
      if (!raw) continue;
      const u = currentUsage(raw, now);
      const allowed15 = Math.floor(u.limit15 * share15);
      const allowedDay = Math.floor(u.limitDay * shareDay);
      if (u.usageDay >= allowedDay) {
        wait = Math.max(wait, dayStart(now) + DAY - now);
        continue;
      }
      if (u.usage15 >= allowed15) {
        wait = Math.max(wait, windowStart15(now) + FIFTEEN_MIN - now);
        continue;
      }
      if (priority === "backfill") {
        // Spread what is left evenly over the rest of each window.
        const left15 = windowStart15(now) + FIFTEEN_MIN - now;
        const leftDay = dayStart(now) + DAY - now;
        const interval = Math.max(left15 / (allowed15 - u.usage15), leftDay / (allowedDay - u.usageDay));
        wait = Math.max(wait, this.lastStart.backfill + interval - now);
      }
    }
    return Math.max(0, wait);
  }

  /** Wait until a request may start, then claim the slot. Gives up (returns false) after maxWaitMs. */
  async acquire(
    priority: Priority,
    method: string,
    path: string,
    maxWaitMs = Number.POSITIVE_INFINITY,
  ): Promise<boolean> {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const delay = this.delayFor(priority, method, path);
      if (delay === 0) break;
      if (this.now() + delay > deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(delay, 30 * SECOND)));
    }
    this.lastStart[priority] = this.now();
    // Count the request locally until its response reports the real figure, so a burst
    // of concurrent starts cannot overshoot.
    this.attempts.overall++;
    if (method === "GET") this.attempts.read++;
    for (const u of [this.estimatedOverall, method === "GET" ? this.estimatedRead : null]) {
      if (!u) continue;
      const c = currentUsage(u, this.now());
      Object.assign(u, { usage15: c.usage15 + 1, usageDay: c.usageDay + 1, observedAt: this.now() });
    }
    return true;
  }

  status(): Record<string, unknown> {
    const now = this.now();
    const show = (u: Usage | null) =>
      u &&
      (({ usage15, usageDay, limit15, limitDay }) => ({ usage15, usageDay, limit15, limitDay }))(currentUsage(u, now));
    return {
      read: show(this.estimatedRead),
      overall: show(this.estimatedOverall),
      request_scope: "Strava API attempts; OAuth token refresh is separate and its allowance is unknown.",
      accounting:
        "Conservative local estimates using known header limits, not a guaranteed remaining allowance. Missing pools are unknown. Other clients may consume quota; local reservations reset on restart.",
      header_observations: { overall: this.overall, read: this.read },
      attempts_this_process: { ...this.attempts },
      shares: SHARE,
      unknown_accounting_paths: [...this.unknownPaths],
      blocked_until: now < this.blockedUntil ? new Date(this.blockedUntil).toISOString() : null,
      uncounted_paths: [], // Compatibility: no endpoint is treated as quota-free.
      next_15min_reset: new Date(windowStart15(now) + FIFTEEN_MIN).toISOString(),
      next_daily_reset: new Date(dayStart(now) + DAY).toISOString(),
    };
  }
}
