/**
 * Who may read the canonical export: the static EXPORT_TOKEN, tokens this server issues after an OAuth sign-in
 * (built-in mode: the user approves by entering EXPORT_TOKEN once on /oauth/authorize), or, with EXPORT_OIDC_ISSUER
 * set, JWTs from that identity provider issued to EXPORT_OIDC_CLIENT_ID (OIDC mode). The browser app runs the same
 * authorization-code + PKCE flow against either. Token format and texts match garmin-mcp's export_auth.py.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export const CLIENT_ID = "effortcurve";
const CODE_TTL = 120;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 86400;

const b64 = (d: Buffer | string) => Buffer.from(d).toString("base64url");
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

export interface ExportAuthOptions {
  exportToken: string;
  corsOrigins: string[];
  oidcIssuer?: string;
  oidcClientId?: string;
  fetchJson?: (url: string) => Promise<Record<string, string>>;
  now?: () => number;
  /** Test hook: the key resolver `jose` verifies OIDC tokens with. */
  jwks?: JWTVerifyGetKey;
  /** Test hook: skip the 1 s delay after a wrong token. */
  noDelay?: boolean;
}

// Chrome applies form-action to the redirect after the POST, so the app's origin is listed too.
const htmlHeaders = (origin: string) => ({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${origin}`,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

export class ExportAuth {
  readonly mode: "oidc" | "builtin";
  private disc: { until: number; doc: Record<string, string> } | null = null;
  private jwks: JWTVerifyGetKey | null;
  private readonly now: () => number;

  constructor(private readonly o: ExportAuthOptions) {
    this.mode = o.oidcIssuer ? "oidc" : "builtin";
    this.now = o.now ?? (() => Date.now() / 1000);
    this.jwks = o.jwks ?? null;
  }

  private get clientId(): string {
    return this.o.oidcClientId || CLIENT_ID;
  }

  private key(): Buffer {
    return createHmac("sha256", this.o.exportToken).update("effortcurve-oauth-v1").digest();
  }

  issue(kind: "code" | "access" | "refresh", ttl: number, extra: Record<string, string> = {}): string {
    const payload = b64(
      JSON.stringify({ t: kind, exp: Math.floor(this.now()) + ttl, n: randomBytes(16).toString("hex"), ...extra }),
    );
    const sig = b64(createHmac("sha256", this.key()).update(`ec1.${payload}`).digest());
    return `ec1.${payload}.${sig}`;
  }

  check(token: string, kind: string): Record<string, string | number> | null {
    try {
      const [prefix, payload, sig] = token.split(".");
      if (prefix !== "ec1" || !payload || !sig) return null;
      const want = createHmac("sha256", this.key()).update(`ec1.${payload}`).digest();
      const got = Buffer.from(sig, "base64url");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (data.t !== kind || Number(data.exp) < this.now()) return null;
      return data;
    } catch {
      return null;
    }
  }

  allowedRedirect(uri: string): boolean {
    try {
      const u = new URL(uri);
      if (u.pathname !== "/oauth/callback" || u.search || u.hash) return false;
      if (u.protocol === "http:" && u.hostname !== "localhost") return false;
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return this.o.corsOrigins.includes(u.origin);
    } catch {
      return false;
    }
  }

  private async discovery(): Promise<Record<string, string>> {
    if (this.disc && this.disc.until > this.now()) return this.disc.doc;
    const url = `${this.o.oidcIssuer!.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const doc = this.o.fetchJson
      ? await this.o.fetchJson(url)
      : ((await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json()) as Record<string, string>);
    this.disc = { until: this.now() + 3600, doc };
    return doc;
  }

  async metadata(base: string): Promise<Record<string, string>> {
    if (this.mode === "oidc") {
      const d = await this.discovery();
      return {
        mode: "oidc",
        issuer: this.o.oidcIssuer!,
        authorization_endpoint: d.authorization_endpoint!,
        token_endpoint: d.token_endpoint!,
        client_id: this.clientId,
        scope: "openid offline_access",
      };
    }
    return {
      mode: "builtin",
      issuer: `${base}/oauth`,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      client_id: CLIENT_ID,
      scope: "export",
    };
  }

  async allows(header: string | undefined): Promise<boolean> {
    if (!header?.startsWith("Bearer ")) return false;
    const tok = header.slice(7);
    if (this.o.exportToken) {
      const a = Buffer.from(tok);
      const b = Buffer.from(this.o.exportToken);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
      if (tok.startsWith("ec1.")) return this.check(tok, "access") !== null;
    }
    if (this.mode === "oidc") {
      try {
        if (!this.jwks) this.jwks = createRemoteJWKSet(new URL((await this.discovery()).jwks_uri!));
        const { payload } = await jwtVerify(tok, this.jwks, {
          issuer: this.o.oidcIssuer,
          algorithms: ["RS256", "ES256", "EdDSA"],
        });
        return payload.client_id === this.clientId || payload.azp === this.clientId;
      } catch {
        return false;
      }
    }
    return false;
  }

  private page(p: Record<string, string>, error = "", status = 200): Response {
    const u = new URL(p.redirect_uri!);
    const hidden = Object.entries(p)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
      .join("");
    const err = error ? `<p class="e">${esc(error)}</p>` : "";
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
<style>body{font:16px system-ui;max-width:26rem;margin:12vh auto;padding:0 1rem}input[type=password]{width:100%;padding:.5rem;margin:.5rem 0}button{padding:.5rem 1rem;margin-right:.5rem}.e{color:#b00020}</style>
<h1>Effort Curve</h1><p><strong>${esc(u.origin)}</strong> wants to read your activities from this server.</p>${err}
<form method="post">${hidden}<label>Export token<input type="password" name="token" autocomplete="off" autofocus></label>
<button name="action" value="approve">Approve</button><button name="action" value="deny">Deny</button></form>`;
    return new Response(body, { status, headers: htmlHeaders(u.origin) });
  }

  private bad(msg: string): Response {
    return new Response(`<!doctype html><meta charset=utf-8><p>${esc(msg)}</p>`, {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  async authorize(req: Request): Promise<Response> {
    if (this.mode !== "builtin") return new Response("Not found", { status: 404 });
    const form: Record<string, string> =
      req.method === "POST"
        ? Object.fromEntries(new URLSearchParams(await req.text()))
        : Object.fromEntries(new URL(req.url).searchParams);
    const p: Record<string, string> = {};
    for (const k of [
      "response_type",
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]) {
      p[k] = form[k] ?? "";
    }
    if (
      p.response_type !== "code" ||
      p.client_id !== CLIENT_ID ||
      p.code_challenge_method !== "S256" ||
      !p.code_challenge ||
      !p.state
    ) {
      return this.bad("Invalid sign-in request.");
    }
    if (!this.allowedRedirect(p.redirect_uri!))
      return this.bad("This site is not in EXPORT_CORS_ORIGINS on this server.");
    if (req.method !== "POST") return this.page(p);
    const back = (q: Record<string, string>) =>
      new Response(null, { status: 303, headers: { location: `${p.redirect_uri}?${new URLSearchParams(q)}` } });
    if (form.action === "deny") return back({ error: "access_denied", state: p.state! });
    const given = Buffer.from(form.token ?? "");
    const want = Buffer.from(this.o.exportToken);
    if (!this.o.exportToken || given.length !== want.length || !timingSafeEqual(given, want)) {
      if (!this.o.noDelay) await new Promise((r) => setTimeout(r, 1000));
      return this.page(p, "That is not this server's export token.", 401);
    }
    const code = this.issue("code", CODE_TTL, { cc: p.code_challenge!, ru: p.redirect_uri! });
    return back({ code, state: p.state! });
  }

  async token(req: Request): Promise<Response> {
    if (this.mode !== "builtin") return new Response("Not found", { status: 404 });
    const h = { "cache-control": "no-store", "content-type": "application/json" };
    const f = Object.fromEntries(new URLSearchParams(await req.text()));
    let ok = false;
    if (f.grant_type === "authorization_code") {
      const c = this.check(f.code ?? "", "code");
      if (c && c.ru === f.redirect_uri) {
        const got = Buffer.from(
          b64(
            createHash("sha256")
              .update(f.code_verifier ?? "")
              .digest(),
          ),
        );
        const want = Buffer.from(String(c.cc));
        ok = got.length === want.length && timingSafeEqual(got, want);
      }
    } else if (f.grant_type === "refresh_token") {
      ok = this.check(f.refresh_token ?? "", "refresh") !== null;
    } else {
      return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400, headers: h });
    }
    if (!ok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: h });
    return new Response(
      JSON.stringify({
        access_token: this.issue("access", ACCESS_TTL),
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        refresh_token: this.issue("refresh", REFRESH_TTL),
        scope: "export",
      }),
      { headers: h },
    );
  }
}
