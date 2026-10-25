/**
 * strava-mcp-auth: authorize the server against your own Strava API application.
 *
 * Prints Strava's authorization URL, waits for the redirect on a local port (or for
 * the redirected URL or code to be pasted, for servers without a browser), exchanges
 * the code for tokens, and writes the token file the server reads (STRAVA_TOKEN_FILE).
 * After that STRAVA_REFRESH_TOKEN is not needed.
 *
 * Strava only redirects to the application's Authorization Callback Domain, so set it
 * to `localhost` in the API settings; the redirect goes to http://localhost:<port>/callback.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { DEFAULT_TOKEN_FILE, STRAVA_TOKEN_URL } from "./constants.js";
import { type StoredTokens, writeTokenFile } from "./token-store.js";

export const DEFAULT_SCOPES = "read,activity:read_all,activity:write,profile:read_all";
export const DEFAULT_PORT = 8765;
const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";

export interface AuthOptions {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
  port: number;
  scopes: string;
  /** Do not listen for the redirect; only accept pasted input. */
  noListen: boolean;
}

export interface Redirect {
  code: string;
  state: string | null;
  scope: string | null;
}

/** The authorization URL the user opens. */
export function authorizeUrl(o: Pick<AuthOptions, "clientId" | "port" | "scopes">, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `http://localhost:${o.port}/callback`);
  url.searchParams.set("approval_prompt", "force");
  url.searchParams.set("scope", o.scopes);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Parse what the user pasted: the whole redirected URL, its query string, or a bare code. */
export function parseRedirect(input: string): Redirect | null {
  const text = input.trim();
  if (!text) return null;
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(text)) params = new URL(text).searchParams;
  else if (text.includes("=")) params = new URLSearchParams(text.replace(/^\?/, ""));
  else if (/^[0-9a-f]{20,}$/i.test(text)) return { code: text, state: null, scope: null };
  else return null;
  const code = params.get("code");
  if (!code) return null;
  return { code, state: params.get("state"), scope: params.get("scope") };
}

/** Scopes from DEFAULT_SCOPES that Strava did not grant (the user unticked them). */
export function missingScopes(requested: string, granted: string | null): string[] {
  if (granted === null) return [];
  const have = new Set(granted.split(",").map((s) => s.trim()));
  // activity:read_all implies activity:read, profile:read_all implies profile:read.
  return requested
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !have.has(s) && !have.has(`${s}_all`));
}

export interface ExchangeResult extends StoredTokens {
  athlete: { id: number; firstname?: string; lastname?: string } | null;
}

/** Exchange an authorization code for tokens at Strava. */
export async function exchangeCode(
  o: Pick<AuthOptions, "clientId" | "clientSecret">,
  code: string,
  scope: string | null,
  http: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const res = await http(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: o.clientId,
      client_secret: o.clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Strava refused the code (HTTP ${res.status}): ${text}`);
  const data = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    athlete?: { id: number; firstname?: string; lastname?: string };
  };
  if (!data.access_token || !data.refresh_token) throw new Error(`Strava's answer has no tokens: ${text}`);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? 0,
    ...(scope ? { scope } : {}),
    ...(data.athlete?.id ? { athlete_id: data.athlete.id } : {}),
    athlete: data.athlete ?? null,
  };
}

/** Wait for Strava's redirect on the port, or for a pasted redirect on stdin, whichever comes first. */
export function waitForRedirect(
  port: number,
  listen: boolean,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<Redirect> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    const rl = createInterface({ input, terminal: false });
    const done = (r: Redirect) => {
      rl.close();
      server?.close();
      resolve(r);
    };
    rl.on("line", (line) => {
      const r = parseRedirect(line);
      if (r) done(r);
      else if (line.trim())
        console.error("That is not a Strava redirect URL or code; paste the full URL from the address bar.");
    });
    if (!listen) return;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      const r = url.pathname === "/callback" ? parseRedirect(url.search) : null;
      if (!r) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(url.searchParams.get("error") ? `Strava reported: ${url.searchParams.get("error")}` : "Not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><title>strava-mcp</title><p>Authorized. You can close this tab and return to the terminal.</p>",
      );
      done(r);
    });
    server.on("error", (err) =>
      reject(
        new Error(
          `Cannot listen on port ${port}: ${err.message}. Use --port, or --no-listen and paste the redirect URL.`,
        ),
      ),
    );
    // All interfaces: in a container the published port forwards here.
    server.listen(port, "0.0.0.0");
  });
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): AuthOptions {
  const o: AuthOptions = {
    clientId: env.STRAVA_CLIENT_ID ?? "",
    clientSecret: env.STRAVA_CLIENT_SECRET ?? "",
    tokenFile: env.STRAVA_TOKEN_FILE || DEFAULT_TOKEN_FILE,
    port: Number(env.STRAVA_AUTH_PORT || DEFAULT_PORT),
    scopes: DEFAULT_SCOPES,
    noListen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--port") o.port = Number(value());
    else if (a.startsWith("--port=")) o.port = Number(a.slice(7));
    else if (a === "--scopes") o.scopes = value();
    else if (a.startsWith("--scopes=")) o.scopes = a.slice(9);
    else if (a === "--token-file") o.tokenFile = value();
    else if (a.startsWith("--token-file=")) o.tokenFile = a.slice(13);
    else if (a === "--no-listen") o.noListen = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`Unknown argument ${a}\n${USAGE}`);
  }
  if (!Number.isInteger(o.port) || o.port <= 0) throw new Error("--port must be a positive integer");
  return o;
}

const USAGE = `Usage: strava-mcp-auth [--port N] [--scopes a,b] [--token-file PATH] [--no-listen]

Authorizes this server against your Strava API application and writes the token file.
Reads STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET and STRAVA_TOKEN_FILE from the environment.

  --port N           Port for the http://localhost:N/callback redirect (default ${DEFAULT_PORT},
                     or STRAVA_AUTH_PORT). The app's Authorization Callback Domain must be localhost.
  --scopes LIST      Scopes to request (default ${DEFAULT_SCOPES})
  --token-file PATH  Where to write the tokens (default STRAVA_TOKEN_FILE or ${DEFAULT_TOKEN_FILE})
  --no-listen        Do not open a port; paste the redirected URL instead (headless servers)`;

export async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  if (!o.clientId || !o.clientSecret) {
    throw new Error("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET (https://www.strava.com/settings/api).");
  }
  const state = randomBytes(12).toString("hex");
  console.log(`Open this URL in a browser and allow access:\n\n  ${authorizeUrl(o, state)}\n`);
  if (o.noListen) {
    console.log("Then paste the URL the browser was redirected to (http://localhost:.../callback?...) here:");
  } else {
    console.log(
      `Waiting for Strava's redirect on http://localhost:${o.port}/callback. If the browser cannot reach this machine\n` +
        "(the page fails to load), paste the URL from its address bar here instead:",
    );
  }
  const redirect = await waitForRedirect(o.port, !o.noListen);
  if (redirect.state && redirect.state !== state)
    throw new Error("The state parameter does not match this run; start again.");
  const missing = missingScopes(o.scopes, redirect.scope);
  const result = await exchangeCode(o, redirect.code, redirect.scope);
  const { athlete, ...tokens } = result;
  writeTokenFile(o.tokenFile, tokens);
  const who = athlete
    ? `${[athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || "athlete"} (id ${athlete.id})`
    : "the athlete";
  console.log(`\nAuthorized ${who}. Tokens written to ${o.tokenFile}.`);
  if (missing.length) {
    console.log(
      `Note: these scopes were not granted: ${missing.join(", ")}. Run again and leave every box ticked if the tools need them.`,
    );
  }
}
