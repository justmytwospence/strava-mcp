import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { splitArray, topLevelId } from "../src/sync/fetchers.js";
import { currentUsage, pathShape, RateLimiter } from "../src/sync/rate-limit.js";

const T0 = Date.UTC(2026, 9, 22, 12, 5, 0); // 12:05 UTC

function headers(read: [number, number], overall: [number, number] = read, limits: [number, number] = [100, 1000]) {
  return new Headers({
    "x-ratelimit-limit": `${limits[0] * 2},${limits[1] * 2}`,
    "x-ratelimit-usage": overall.join(","),
    "x-readratelimit-limit": limits.join(","),
    "x-readratelimit-usage": read.join(","),
  });
}

describe("rate limiter", () => {
  test("usage resets at the quarter hour and at midnight UTC", () => {
    const u = { usage15: 50, usageDay: 500, limit15: 100, limitDay: 1000, observedAt: T0 };
    assert.equal(currentUsage(u, T0 + 5 * 60_000).usage15, 50);
    assert.equal(currentUsage(u, Date.UTC(2026, 9, 22, 12, 15)).usage15, 0);
    assert.equal(currentUsage(u, Date.UTC(2026, 9, 22, 12, 15)).usageDay, 500);
    assert.equal(currentUsage(u, Date.UTC(2026, 9, 23, 0, 0)).usageDay, 0);
  });

  test("each priority stops at its share of the window", () => {
    let now = T0;
    const l = new RateLimiter(() => now);
    l.observe("GET", "/athlete", 200, headers([76, 100]), "interactive");
    assert.ok(l.delayFor("backfill", "GET", "/athlete") > 0, "backfill stops at 75%");
    assert.equal(l.delayFor("incremental", "GET", "/athlete"), 0);
    assert.equal(l.delayFor("interactive", "GET", "/athlete"), 0);
    l.observe("GET", "/athlete", 200, headers([98, 120]), "interactive");
    assert.equal(l.delayFor("interactive", "GET", "/athlete"), 10 * 60_000, "waits for 12:15");
    now = Date.UTC(2026, 9, 22, 12, 15);
    assert.equal(l.delayFor("interactive", "GET", "/athlete"), 0);
  });

  test("the daily share blocks until midnight", () => {
    const l = new RateLimiter(() => T0);
    l.observe("GET", "/athlete", 200, headers([1, 900]), "interactive");
    assert.equal(l.delayFor("incremental", "GET", "/x"), Date.UTC(2026, 9, 23) - T0);
  });

  test("a 429 blocks everyone until the next window", () => {
    const l = new RateLimiter(() => T0);
    l.observe("GET", "/athlete", 429, headers([100, 300]), "interactive");
    assert.equal(l.delayFor("interactive", "GET", "/athlete"), 10 * 60_000);
  });

  test("backfill spreads what is left over the day", () => {
    const now = T0;
    const l = new RateLimiter(() => now);
    l.observe("GET", "/athlete", 200, headers([0, 0]), "backfill");
    // 750 backfill calls left for 11h55m: one every ~57 s once a call has started.
    assert.equal(l.delayFor("backfill", "GET", "/athlete"), 0);
    void l.acquire("backfill", "GET", "/athlete");
    const wait = l.delayFor("backfill", "GET", "/athlete");
    assert.ok(wait > 50_000 && wait < 60_000, `waited ${wait}`);
  });

  test("missing headers remain unknown, never exempt from known pools/reserves", async () => {
    const l = new RateLimiter(() => T0);
    assert.equal(l.status().overall, null);
    l.observe("GET", "/athlete", 200, headers([74, 100]), "backfill");
    assert.equal(await l.acquire("backfill", "GET", "/activities/1/streams", 0), true);
    l.observe("GET", "/activities/123/streams", 200, new Headers(), "backfill");
    assert.equal(l.isCounted("/activities/456/streams"), true);
    assert.ok(l.delayFor("backfill", "GET", "/activities/456/streams") > 0);
    assert.equal(pathShape("/activities/456/streams"), "/activities/{id}/streams");
    const status = l.status();
    assert.deepEqual(status.unknown_accounting_paths, ["GET /activities/{id}/streams"]);
    assert.equal((status.read as { usage15: number }).usage15, 75);
    assert.equal((status.header_observations as { read: { usage15: number; observedAt: number } }).read.usage15, 74);
  });

  test("concurrent admissions cannot use the same last slot and out-of-order headers cannot undo reservations", async () => {
    const l = new RateLimiter(() => T0);
    l.observe("GET", "/athlete", 200, headers([97, 100]), "interactive");
    assert.deepEqual(
      await Promise.all([l.acquire("interactive", "GET", "/x", 0), l.acquire("interactive", "GET", "/x", 0)]),
      [true, false],
    );
    l.observe("GET", "/x", 200, headers([96, 99]), "interactive");
    assert.ok(l.delayFor("interactive", "GET", "/x") > 0);
  });

  test("unknown allowance is paced and malformed headers never become an allowance", async () => {
    const l = new RateLimiter(() => T0);
    assert.equal(await l.acquire("interactive", "GET", "/x", 0), true);
    assert.equal(await l.acquire("interactive", "GET", "/x", 0), false);
    const bad = headers([1, 1]);
    bad.set("x-ratelimit-limit", "0,100");
    bad.set("x-readratelimit-usage", "1x,2");
    l.observe("GET", "/x", 200, bad, "interactive");
    assert.equal(l.status().overall, null);
    assert.equal(l.status().read, null);
  });

  test("429 honors Retry-After seconds/date and daily exhaustion across path shapes", () => {
    for (const retry of ["1200", new Date(T0 + 1200_000).toUTCString()]) {
      const l = new RateLimiter(() => T0);
      l.observe("GET", "/x", 429, new Headers({ "retry-after": retry }), "interactive");
      assert.equal(l.delayFor("interactive", "PUT", "/other"), 1200_000);
    }
    const l = new RateLimiter(() => T0);
    l.observe("GET", "/x", 429, headers([1, 1000]), "interactive");
    assert.equal(l.delayFor("interactive", "GET", "/x"), Date.UTC(2026, 9, 23) - T0);
  });

  test("writes are limited by the overall pool only", () => {
    const l = new RateLimiter(() => T0);
    l.observe("GET", "/athlete", 200, headers([99, 120], [99, 120]), "interactive");
    assert.ok(l.delayFor("interactive", "GET", "/athlete") > 0);
    assert.equal(l.delayFor("interactive", "PUT", "/activities/1"), 0);
  });
});

describe("raw JSON splitting", () => {
  test("splits array elements exactly as sent", () => {
    const text = '[ {"id": 3377135020653606222, "a": [1, {"b": "x,]"}]}, {"id": 2} ,{"id":3}]';
    const parts = splitArray(text);
    assert.equal(parts.length, 3);
    assert.equal(parts[0], '{"id": 3377135020653606222, "a": [1, {"b": "x,]"}]}');
    assert.equal(topLevelId(parts[0]!), "3377135020653606222");
    assert.deepEqual(splitArray("[]"), []);
  });

  test("finds the top-level id, not a nested one", () => {
    assert.equal(topLevelId('{"athlete": {"id": 7}, "name": "\\"id\\": 9", "id": 42}'), "42");
  });
});
