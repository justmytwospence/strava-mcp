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
import type { Database } from "./db/database.js";
import { syncExport } from "./export.js";
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
