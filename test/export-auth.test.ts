/** Signing in to the canonical export: built-in OAuth (PKCE) and OIDC JWTs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import { CanonicalExporter } from "../src/canonical.js";
import { Database } from "../src/db/database.js";
import { ExportAuth } from "../src/export-auth.js";
import { createHttpApp } from "../src/http.js";
import { SnapshotPublisher } from "../src/snapshot.js";

const ORIGIN = "https://effortcurve.com";
const CB = `${ORIGIN}/oauth/callback`;
const BASE = "http://localhost/export/canonical/v1";
const b64 = (b: Buffer) => b.toString("base64url");
const challenge = (v: string) => b64(createHash("sha256").update(v).digest());
const query = (v = "v".repeat(43)) => ({
  response_type: "code",
  client_id: "effortcurve",
  redirect_uri: CB,
  state: "s1",
  code_challenge: challenge(v),
  code_challenge_method: "S256",
});
const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});

async function setup(auth: ExportAuth) {
  const dir = mkdtempSync(join(tmpdir(), "strava-auth-"));
  const db = await Database.open({ path: join(dir, "s.duckdb"), snapshotDir: join(dir, "snap") });
  const exp = new CanonicalExporter(join(dir, "export", "canonical-v1"), "t");
  mkdirSync(exp.outDir, { recursive: true });
  writeFileSync(exp.manifestPath, '{"schema_version":1,"activities":[]}');
  const app = createHttpApp({
    handler: { fetch: async () => new Response("x") } as never,
    db,
    snapshot: new SnapshotPublisher(db),
    webhook: null,
    allowedHosts: [],
    mcpToken: "m",
    snapshotToken: "s",
    exporter: exp,
    exportToken: "tok",
    exportCorsOrigins: [ORIGIN],
    exportAuth: auth,
  });
  return {
    app,
    done: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const manifest = (app: ReturnType<typeof createHttpApp>, bearer?: string) =>
  app.request(`${BASE}/manifest.json`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

test("metadata, the approval page and redirect checks", async () => {
  const { app, done } = await setup(new ExportAuth({ exportToken: "tok", corsOrigins: [ORIGIN], noDelay: true }));
  try {
    const r = await app.request(`${BASE}/auth`, { headers: { origin: ORIGIN } });
    const m = (await r.json()) as Record<string, string>;
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(m.mode, "builtin");
    assert.equal(m.client_id, "effortcurve");
    assert.equal(m.authorization_endpoint, `${BASE}/oauth/authorize`);
    assert.equal(m.token_endpoint, `${BASE}/oauth/token`);
    const page = await app.request(`${BASE}/oauth/authorize?${new URLSearchParams(query())}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.ok((page.headers.get("content-security-policy") ?? "").includes(`form-action 'self' ${ORIGIN}`));
    assert.match(await page.text(), /type="password"/);
    for (const bad of ["https://evil.example/oauth/callback", `${ORIGIN}/other`, `${ORIGIN}/oauth/callback?x=1`]) {
      const r2 = await app.request(`${BASE}/oauth/authorize?${new URLSearchParams({ ...query(), redirect_uri: bad })}`);
      assert.equal(r2.status, 400);
    }
  } finally {
    done();
  }
});

test("a wrong token and deny give no code", async () => {
  const { app, done } = await setup(new ExportAuth({ exportToken: "tok", corsOrigins: [ORIGIN], noDelay: true }));
  try {
    const r = await app.request(`${BASE}/oauth/authorize`, form({ ...query(), token: "nope", action: "approve" }));
    assert.equal(r.status, 401);
    assert.ok((r.headers.get("content-security-policy") ?? "").includes(`form-action 'self' ${ORIGIN}`));
    assert.ok(!(await r.text()).includes("code="));
    const d = await app.request(`${BASE}/oauth/authorize`, form({ ...query(), action: "deny" }));
    assert.equal(d.status, 303);
    assert.match(d.headers.get("location") ?? "", /error=access_denied/);
  } finally {
    done();
  }
});

test("the code flow, access, refresh, expiry and the static token", async () => {
  let t = 1_000_000;
  const { app, done } = await setup(new ExportAuth({ exportToken: "tok", corsOrigins: [ORIGIN], now: () => t }));
  try {
    const approve = async () => {
      const r = await app.request(`${BASE}/oauth/authorize`, form({ ...query(), token: "tok", action: "approve" }));
      assert.equal(r.status, 303);
      const loc = new URL(r.headers.get("location")!);
      assert.equal(loc.searchParams.get("state"), "s1");
      return loc.searchParams.get("code")!;
    };
    const token = (o: Record<string, string>) => app.request(`${BASE}/oauth/token`, form(o));
    const code = await approve();
    assert.equal(
      (await token({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: "w".repeat(43) })).status,
      400,
    );
    assert.equal(
      (
        await token({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${ORIGIN}/x`,
          code_verifier: "v".repeat(43),
        })
      ).status,
      400,
    );
    const ok = await token({ grant_type: "authorization_code", code, redirect_uri: CB, code_verifier: "v".repeat(43) });
    assert.equal(ok.status, 200);
    const tk = (await ok.json()) as { access_token: string; refresh_token: string };
    assert.equal((await manifest(app, tk.access_token)).status, 200);
    const flipped = tk.access_token.slice(0, -1) + (tk.access_token.endsWith("A") ? "B" : "A");
    assert.equal((await manifest(app, flipped)).status, 401);
    assert.equal((await manifest(app, tk.refresh_token)).status, 401);
    assert.equal((await manifest(app, "tok")).status, 200);
    assert.equal((await manifest(app)).status, 401);
    const r = await token({ grant_type: "refresh_token", refresh_token: tk.refresh_token });
    assert.equal(r.status, 200);
    assert.notEqual(((await r.json()) as { access_token: string }).access_token, tk.access_token);
    const code2 = await approve();
    t += 200;
    assert.equal(
      (await token({ grant_type: "authorization_code", code: code2, redirect_uri: CB, code_verifier: "v".repeat(43) }))
        .status,
      400,
    );
    t += 91 * 86400;
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: tk.refresh_token })).status, 400);
  } finally {
    done();
  }
});

test("OIDC mode accepts the provider's tokens for the effortcurve client only", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const iss = "https://auth.example.com";
  const jwks: JWTVerifyGetKey = async () => publicKey;
  const auth = new ExportAuth({
    exportToken: "tok",
    corsOrigins: [ORIGIN],
    oidcIssuer: iss,
    fetchJson: async () => ({
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/api/oidc/token`,
      jwks_uri: `${iss}/jwks`,
    }),
    jwks,
  });
  const { app, done } = await setup(auth);
  try {
    const mint = (claims: Record<string, unknown>, issuer = iss, exp: string | number = "10m") =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setExpirationTime(exp)
        .sign(privateKey);
    assert.equal((await manifest(app, await mint({ client_id: "effortcurve" }))).status, 200);
    assert.equal((await manifest(app, await mint({ azp: "effortcurve" }))).status, 200);
    assert.equal((await manifest(app, await mint({ client_id: "other" }))).status, 401);
    assert.equal(
      (await manifest(app, await mint({ client_id: "effortcurve" }, iss, Math.floor(Date.now() / 1000) - 60))).status,
      401,
    );
    assert.equal((await manifest(app, await mint({ client_id: "effortcurve" }, "https://evil.example"))).status, 401);
    const m = (await (await app.request(`${BASE}/auth`)).json()) as Record<string, string>;
    assert.equal(m.mode, "oidc");
    assert.equal(m.token_endpoint, `${iss}/api/oidc/token`);
    assert.equal(m.client_id, "effortcurve");
    assert.equal((await app.request(`${BASE}/oauth/authorize?${new URLSearchParams(query())}`)).status, 404);
  } finally {
    done();
  }
});
