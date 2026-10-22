import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RateLimiter, currentUsage, pathShape } from "../src/sync/rate-limit.js";
import { splitArray, topLevelId } from "../src/sync/fetchers.js";

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

  test("responses without rate headers mark the path uncounted", () => {
    const l = new RateLimiter(() => T0);
    l.observe("GET", "/athlete", 200, headers([75, 100]), "backfill");
    assert.ok(l.delayFor("backfill", "GET", "/activities/1/streams") > 0);
    l.observe("GET", "/activities/123/streams", 200, new Headers(), "backfill");
    assert.ok(!l.isCounted("/activities/456/streams"));
    assert.equal(pathShape("/activities/456/streams"), "/activities/{id}/streams");
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
