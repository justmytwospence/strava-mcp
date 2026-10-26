import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const rateHeaders = {
  "content-type": "application/json",
  "x-ratelimit-limit": "2000,20000",
  "x-ratelimit-usage": "10,10",
  "x-readratelimit-limit": "1000,10000",
  "x-readratelimit-usage": "10,10",
};

test("fake HTTP: explicit 401 replay counts both attempts; ambiguous writes and 429 are never replayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strava-client-budget-"));
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    STRAVA_ACCESS_TOKEN: "synthetic",
    STRAVA_REFRESH_TOKEN: "synthetic",
    STRAVA_CLIENT_ID: "synthetic",
    STRAVA_CLIENT_SECRET: "synthetic",
    STRAVA_TOKEN_FILE: join(dir, "tokens.json"),
  });
  try {
    const { requestRaw, limiter } = await import("../src/strava-client.js");
    const samples: number[] = [];
    limiter.onSample((s) => samples.push(s.status));
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (String(url).includes("oauth/token")) {
        return Response.json({ access_token: "synthetic", refresh_token: "synthetic", expires_at: 9999999999 });
      }
      return new Response("{}", { status: calls === 1 ? 401 : 200, headers: rateHeaders });
    };
    await requestRaw("GET", "/athlete", { maxWaitMs: 0 });
    assert.equal(calls, 3);
    assert.deepEqual(samples, [401, 200]);
    assert.deepEqual(limiter.status().attempts_this_process, { overall: 2, read: 2 });
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError("synthetic lost response");
    };
    await assert.rejects(requestRaw("POST", "/activities", { body: { name: "synthetic" }, maxWaitMs: 0 }));
    assert.equal(calls, 1, "ambiguous creation must not be replayed");
    globalThis.fetch = async () => {
      calls++;
      return new Response("rate limited", { status: 429, headers: { ...rateHeaders, "retry-after": "1800" } });
    };
    await assert.rejects(requestRaw("PUT", "/activities/1", { body: {}, maxWaitMs: 0 }));
    assert.equal(calls, 2);
    await assert.rejects(requestRaw("GET", "/athlete", { maxWaitMs: 0 }), /rate limit/);
    assert.equal(calls, 2, "cooldown admission must not reach transport");
    assert.deepEqual(limiter.status().attempts_this_process, { overall: 4, read: 2 });
  } finally {
    globalThis.fetch = originalFetch;
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
