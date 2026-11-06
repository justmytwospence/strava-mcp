/**
 * The HTTP app (MCP_TRANSPORT=http): the MCP endpoint, the health check, the snapshot
 * and export endpoints for other readers, and Strava's webhook callback. index.ts
 * builds the pieces and hands them here; this file only wires routes and checks
 * bearers.
 */
import { timingSafeEqual } from "node:crypto";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { CanonicalExporter } from "./canonical.js";
import type { Database } from "./db/database.js";
import { syncExport } from "./export.js";
import { ExportAuth } from "./export-auth.js";
import { SERVER_NAME, VERSION } from "./server.js";
import type { SnapshotPublisher } from "./snapshot.js";
import type { StravaWebhook, WebhookEvent } from "./webhook.js";

export interface HttpOptions {
  handler: McpHttpHandler;
  db: Database;
  snapshot: SnapshotPublisher;
  webhook: StravaWebhook | null;
  /**
   * Hostnames clients may use in the Host header, on top of localhost (DNS-rebinding
   * protection). Empty means any host is accepted, which is right when the server is
   * reachable only on a private network; set it when a reverse proxy forwards a public
   * hostname to the server, so that only that hostname is accepted.
   */
  allowedHosts: string[];
  /** Bearer token required on /mcp; empty leaves the endpoint open. */
  mcpToken: string;
  /** Bearer token for /snapshot.duckdb and /export/sync; empty disables both. */
  snapshotToken: string;
  /** The canonical export (STRAVA_EXPORT=canonical), its own bearer token and the origins a browser app may read it from. */
  exporter: CanonicalExporter | null;
  exportToken: string;
  exportCorsOrigins: string[];
  /** Sign-in for the export (built-in OAuth or OIDC); built from the export settings when omitted. */
  exportAuth?: ExportAuth;
}

/** Constant-time comparison of an Authorization header with the expected bearer. */
export function bearerMatches(token: string, header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createHttpApp(o: HttpOptions): Hono {
  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: o.allowedHosts.length ? ["localhost", "127.0.0.1", ...o.allowedHosts] : undefined,
  });

  // The canonical export: CORS for the configured origins on these routes only (never /mcp or the snapshot).
  const EXPORT_PREFIX = "/export/canonical/v1/";
  app.use(`${EXPORT_PREFIX}*`, async (c, next) => {
    await next();
    if (
      c.req.method === "OPTIONS" &&
      c.req.header("access-control-request-private-network") === "true" &&
      c.res.headers.has("access-control-allow-origin")
    ) {
      c.res.headers.set("access-control-allow-private-network", "true");
    }
  });
  app.use(
    `${EXPORT_PREFIX}*`,
    cors({
      origin: (origin) => (origin && o.exportCorsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      exposeHeaders: ["ETag"],
      maxAge: 86400,
    }),
  );
  const exportAuth = o.exportAuth ?? new ExportAuth({ exportToken: o.exportToken, corsOrigins: o.exportCorsOrigins });
  const exportBase = (c: Context) => {
    const u = new URL(c.req.url);
    const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
    return `${proto}://${host}${EXPORT_PREFIX.slice(0, -1)}`;
  };
  const exportOff = () => "Export serving is disabled (set STRAVA_EXPORT=canonical and EXPORT_TOKEN)";
  // sign-in routes first: the catch-all below serves files
  app.get(`${EXPORT_PREFIX}auth`, async (c) => {
    if (!o.exportToken || !o.exporter) return c.text(exportOff(), 404);
    try {
      return c.json(await exportAuth.metadata(exportBase(c)), 200, { "cache-control": "no-store" });
    } catch {
      return c.text("The identity provider could not be reached", 502);
    }
  });
  app.on(["GET", "POST"], `${EXPORT_PREFIX}oauth/authorize`, (c) =>
    !o.exportToken || !o.exporter ? c.text(exportOff(), 404) : exportAuth.authorize(c.req.raw),
  );
  app.post(`${EXPORT_PREFIX}oauth/token`, (c) =>
    !o.exportToken || !o.exporter ? c.text(exportOff(), 404) : exportAuth.token(c.req.raw),
  );
  app.on(["GET", "HEAD"], `${EXPORT_PREFIX}*`, async (c) => {
    if (!o.exportToken || !o.exporter) return c.text(exportOff(), 404);
    if (!(await exportAuth.allows(c.req.header("authorization")))) return c.text("Unauthorized", 401);
    return o.exporter.serve(new URL(c.req.url).pathname.slice(EXPORT_PREFIX.length));
  });

  app.get("/health", (c) => c.json({ status: "ok", name: SERVER_NAME, version: VERSION }));

  // The read-only snapshot, for notebooks and dashboards. Disabled without a token.
  app.on(["GET", "HEAD"], "/snapshot.duckdb", (c) => {
    if (!o.snapshotToken) return c.text("Snapshot serving is disabled (set SNAPSHOT_TOKEN)", 404);
    if (!bearerMatches(o.snapshotToken, c.req.header("authorization"))) return c.text("Unauthorized", 401);
    return o.snapshot.serve(c.req.raw);
  });

  // A small live export for other services (see docs/reference/export.md); same token.
  // /export/garmin-sync is the name it had in 4.2 and stays as an alias.
  app.on("GET", ["/export/sync", "/export/garmin-sync"], async (c) => {
    if (!o.snapshotToken) return c.text("Export is disabled (set SNAPSHOT_TOKEN)", 404);
    if (!bearerMatches(o.snapshotToken, c.req.header("authorization"))) return c.text("Unauthorized", 401);
    const raw = c.req.query("since");
    const since = raw ? new Date(raw) : null;
    if (since && Number.isNaN(since.getTime())) return c.text("since must be an ISO date or timestamp", 400);
    return c.json(await syncExport(o.db, since));
  });

  // Strava's webhook callback: public, authenticated by its secret path and the
  // subscription/athlete checks; events only queue re-fetches.
  if (o.webhook) {
    const webhook = o.webhook;
    app.get(webhook.path, (c) => {
      const r = webhook.validate(new URL(c.req.url).searchParams);
      return c.json(r.body, r.status as 200 | 403);
    });
    app.post(webhook.path, async (c) => {
      let event: WebhookEvent;
      try {
        event = await c.req.json();
      } catch {
        return c.text("bad request", 400);
      }
      void webhook.handle(event).catch((err) => console.error("strava webhook: event failed:", err));
      return c.text("ok");
    });
  }

  // The MCP endpoint. MCP_BEARER_TOKEN is the only thing between it and whoever can
  // reach the port (or, with the oauth profile, the gateway's own bearer): the Compose
  // file requires it, and only a trusted private network justifies leaving it unset.
  const mcp = (c: Context) => {
    if (o.mcpToken && !bearerMatches(o.mcpToken, c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return o.handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
  };
  app.all("/mcp", mcp);
  app.all("/", mcp);

  return app;
}
