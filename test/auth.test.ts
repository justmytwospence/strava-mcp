/**
 * The authorization command: URL building, parsing what the user pastes, the code
 * exchange against a fake Strava, the token file, and the local redirect listener.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { authorizeUrl, exchangeCode, missingScopes, parseArgs, parseRedirect, waitForRedirect } from "../src/auth.js";
import { readTokenFile, writeTokenFile } from "../src/token-store.js";

const app = { clientId: "12345", clientSecret: "s3cret" };

describe("authorize URL", () => {
  test("asks for the scopes with a localhost redirect and the state", () => {
    const url = new URL(authorizeUrl({ ...app, port: 8765, scopes: "read,activity:read_all" }, "st4te"));
    assert.equal(url.origin + url.pathname, "https://www.strava.com/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "12345");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8765/callback");
    assert.equal(url.searchParams.get("scope"), "read,activity:read_all");
    assert.equal(url.searchParams.get("state"), "st4te");
    assert.equal(url.searchParams.get("approval_prompt"), "force");
  });
});

describe("pasted redirects", () => {
  test("accepts the full URL, the query string or a bare code", () => {
    const full = parseRedirect("http://localhost:8765/callback?state=abc&code=0123456789abcdef0123456789abcdef&scope=read,activity:read_all");
    assert.deepEqual(full, { code: "0123456789abcdef0123456789abcdef", state: "abc", scope: "read,activity:read_all" });
    assert.deepEqual(parseRedirect("?code=0123456789abcdef0123456789abcdef&state=abc"), { code: "0123456789abcdef0123456789abcdef", state: "abc", scope: null });
    assert.deepEqual(parseRedirect(" 0123456789abcdef0123456789abcdef \n"), { code: "0123456789abcdef0123456789abcdef", state: null, scope: null });
    assert.equal(parseRedirect("http://localhost:8765/callback?error=access_denied"), null);
    assert.equal(parseRedirect("hello"), null);
    assert.equal(parseRedirect(""), null);
  });

  test("reports scopes the athlete did not grant", () => {
    assert.deepEqual(missingScopes("read,activity:read_all,activity:write,profile:read_all", "read,activity:read_all,profile:read_all"), ["activity:write"]);
    assert.deepEqual(missingScopes("read,activity:read_all", "read,activity:read_all,activity:write"), []);
    assert.deepEqual(missingScopes("read,activity:read_all", null), []);
  });
});

describe("code exchange", () => {
  test("posts the code and returns the tokens and athlete", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({
        token_type: "Bearer",
        access_token: "acc",
        refresh_token: "ref",
        expires_at: 1_900_000_000,
        athlete: { id: 42, firstname: "Ada", lastname: "L" },
      });
    }) as typeof fetch;
    const r = await exchangeCode(app, "c0de", "read,activity:read_all", http);
    assert.equal(calls[0]!.url, "https://www.strava.com/oauth/token");
    assert.deepEqual(calls[0]!.body, { client_id: "12345", client_secret: "s3cret", code: "c0de", grant_type: "authorization_code" });
    assert.deepEqual(r, {
      access_token: "acc",
      refresh_token: "ref",
      expires_at: 1_900_000_000,
      scope: "read,activity:read_all",
      athlete_id: 42,
      athlete: { id: 42, firstname: "Ada", lastname: "L" },
    });
  });

  test("surfaces Strava's refusal", async () => {
    const http = (async () => new Response('{"message":"Bad Request","errors":[{"code":"invalid"}]}', { status: 400 })) as typeof fetch;
    await assert.rejects(exchangeCode(app, "bad", null, http), /HTTP 400.*invalid/);
  });
});

describe("token file", () => {
  test("is written atomically with owner-only permissions in the server's format", () => {
    const dir = mkdtempSync(join(tmpdir(), "strava-auth-"));
    try {
      const path = join(dir, "nested", "tokens.json");
      writeTokenFile(path, { access_token: "acc", refresh_token: "ref", expires_at: 1, scope: "read", athlete_id: 42 });
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { access_token: "acc", refresh_token: "ref", expires_at: 1, scope: "read", athlete_id: 42 });
      assert.deepEqual(readTokenFile(path), { access_token: "acc", refresh_token: "ref", expires_at: 1, scope: "read", athlete_id: 42 });
      assert.equal(readTokenFile(join(dir, "missing.json")), null);
      writeTokenFile(path, { access_token: "", refresh_token: "", expires_at: 0 });
      assert.equal(readTokenFile(path), null, "a file without a refresh token counts as absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("redirect listener", () => {
  test("answers Strava's redirect on the port and resolves with the code", async () => {
    const port = 18765 + Math.floor(Math.random() * 1000);
    const input = new PassThrough();
    const waiting = waitForRedirect(port, true, input);
    const res = await fetch(`http://127.0.0.1:${port}/callback?state=s&code=0123456789abcdef0123456789abcdef&scope=read`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Authorized/);
    assert.deepEqual(await waiting, { code: "0123456789abcdef0123456789abcdef", state: "s", scope: "read" });
    input.end();
  });

  test("accepts a pasted redirect instead", async () => {
    const input = new PassThrough();
    const waiting = waitForRedirect(1, false, input);
    input.write("not a url\n");
    input.write("http://localhost:8765/callback?state=s&code=0123456789abcdef0123456789abcdef\n");
    assert.deepEqual(await waiting, { code: "0123456789abcdef0123456789abcdef", state: "s", scope: null });
    input.end();
  });
});

describe("arguments", () => {
  test("come from the environment with flags on top", () => {
    const env = { STRAVA_CLIENT_ID: "1", STRAVA_CLIENT_SECRET: "x", STRAVA_TOKEN_FILE: "/data/tokens.json" };
    const o = parseArgs(["--port", "9000", "--no-listen"], env);
    assert.equal(o.port, 9000);
    assert.equal(o.noListen, true);
    assert.equal(o.tokenFile, "/data/tokens.json");
    assert.equal(parseArgs(["--token-file=/tmp/t.json", "--scopes=read"], env).tokenFile, "/tmp/t.json");
    assert.throws(() => parseArgs(["--bogus"], env), /Unknown argument/);
    assert.throws(() => parseArgs(["--port", "x"], env), /positive integer/);
  });
});
