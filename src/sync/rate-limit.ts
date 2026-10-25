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
 * of the window instead of bursting. Some endpoints (activity streams, observed) answer
 * without rate headers and do not move the counters; those are learned per path shape
 * and only lightly paced.
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
/** Minimum spacing for uncounted calls of background priorities. */
const UNCOUNTED_SPACING_MS = SECOND;

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
  const [a, b] = value.split(",").map((s) => Number.parseInt(s.trim(), 10));
  return Number.isFinite(a) && Number.isFinite(b) ? [a!, b!] : null;
}

function parseUsage(limit: string | null, usage: string | null, at: number): Usage | null {
  const l = parsePair(limit);
  const u = parsePair(usage);
  if (!l || !u) return null;
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
  return path.split("?")[0]!.replace(/\/\d+(?=\/|$)/g, "/{id}");
}

export class RateLimiter {
  overall: Usage | null = null;
  read: Usage | null = null;
  /** No request of any priority before this time (after a 429). */
  blockedUntil = 0;
  private lastStart: Record<Priority, number> = { interactive: 0, incremental: 0, backfill: 0 };
  private uncounted = new Set<string>();
  private listeners: Array<(s: RateSample) => void> = [];

  constructor(private readonly now: () => number = Date.now) {}

  onSample(fn: (s: RateSample) => void): void {
    this.listeners.push(fn);
  }

  /** Seed from the last persisted sample, so a restart does not forget today's usage. */
  restore(overall: Usage | null, read: Usage | null): void {
    this.overall = overall;
    this.read = read;
  }

  isCounted(path: string): boolean {
    return !this.uncounted.has(pathShape(path));
  }

  observe(method: string, path: string, status: number, headers: Headers, priority: Priority): void {
    const at = this.now();
    const overall = parseUsage(headers.get("x-ratelimit-limit"), headers.get("x-ratelimit-usage"), at);
    const read = parseUsage(headers.get("x-readratelimit-limit"), headers.get("x-readratelimit-usage"), at);
    if (overall) this.overall = overall;
    if (read) this.read = read;
    if (!overall && !read && status >= 200 && status < 300) this.uncounted.add(pathShape(path));
    if (overall || read) this.uncounted.delete(pathShape(path));
    if (status === 429) this.blockedUntil = Math.max(this.blockedUntil, this.next429Release(at));
    for (const fn of this.listeners) fn({ observedAt: new Date(at), method, path, status, priority, overall, read });
  }

  /** On a 429, wait for the next 15-minute boundary, or midnight UTC if a daily limit is spent. */
  private next429Release(at: number): number {
    const spentDaily = [this.overall, this.read].some((u) => u && currentUsage(u, at).usageDay >= u.limitDay);
    return spentDaily ? dayStart(at) + DAY : windowStart15(at) + FIFTEEN_MIN;
  }

  /** Milliseconds until a request of this priority may start (0 = now). */
  delayFor(priority: Priority, method: string, path: string): number {
    const now = this.now();
    if (now < this.blockedUntil) return this.blockedUntil - now;
    const counted = this.isCounted(path);
    if (!counted) {
      if (priority === "interactive") return 0;
      return Math.max(0, this.lastStart[priority] + UNCOUNTED_SPACING_MS - now);
    }
    const [share15, shareDay] = SHARE[priority];
    const pools = [this.overall, method === "GET" ? this.read : null].filter((u): u is Usage => u !== null);
    let wait = 0;
    for (const raw of pools) {
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
  async acquire(priority: Priority, method: string, path: string, maxWaitMs = Number.POSITIVE_INFINITY): Promise<boolean> {
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
    if (this.isCounted(path)) {
      for (const u of [this.overall, method === "GET" ? this.read : null]) {
        if (!u) continue;
        const c = currentUsage(u, this.now());
        Object.assign(u, { usage15: c.usage15 + 1, usageDay: c.usageDay + 1, observedAt: this.now() });
      }
    }
    return true;
  }

  status(): Record<string, unknown> {
    const now = this.now();
    const show = (u: Usage | null) =>
      u && (({ usage15, usageDay, limit15, limitDay }) => ({ usage15, usageDay, limit15, limitDay }))(currentUsage(u, now));
    return {
      read: show(this.read),
      overall: show(this.overall),
      blocked_until: now < this.blockedUntil ? new Date(this.blockedUntil).toISOString() : null,
      uncounted_paths: [...this.uncounted],
      next_15min_reset: new Date(windowStart15(now) + FIFTEEN_MIN).toISOString(),
      next_daily_reset: new Date(dayStart(now) + DAY).toISOString(),
    };
  }
}
