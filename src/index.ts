#!/usr/bin/env node

// Entry point: open the mirror, start the sync, and serve createServer() over stdio
// (default, for local clients that spawn the process) or Streamable HTTP
// (MCP_TRANSPORT=http, for running as a service). The protocol handling is the MCP
// SDK's; this file wires the pieces together.

import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Context } from "hono";
import { setMirror } from "./context.js";
import { Database } from "./db/database.js";
import { Mirror } from "./mirror.js";
import {
  applyUnitsFromEnv,
  createServer,
  resolveUnitsFromProfile,
  SERVER_NAME,
  validateEnv,
  VERSION,
} from "./server.js";
import { SnapshotPublisher } from "./snapshot.js";
import { syncExport } from "./export.js";
import { StravaWebhook, type WebhookEvent } from "./webhook.js";
import { limiter } from "./strava-client.js";
import { SyncEngine } from "./sync/engine.js";
import type { Usage } from "./sync/rate-limit.js";

// `auth` runs the one-time authorization instead of the server (docker compose run ... auth).
if (process.argv[2] === "auth") {
  const { main } = await import("./auth.js");
  await main(process.argv.slice(3)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
  process.exit(0);
}

validateEnv();
const unitsFromEnv = applyUnitsFromEnv();

// ------------------------------------------------------------------ the mirror

const dbPath = process.env.STRAVA_DB_PATH ?? "./state/strava.duckdb";
const db = await Database.open({
  path: dbPath,
  snapshotDir: process.env.STRAVA_SNAPSHOT_DIR ?? join(dirname(dbPath), "snapshot"),
  memoryLimit: process.env.DUCKDB_MEMORY_LIMIT,
  threads: process.env.DUCKDB_THREADS ? Number(process.env.DUCKDB_THREADS) : undefined,
});

// Carry today's rate-limit usage across restarts, and record every request.
const last = await db.one<Record<string, number | string | null>>(
  "SELECT *, epoch_ms(observed_at)::DOUBLE AS at_ms FROM rate_sample WHERE read_limit_15min IS NOT NULL ORDER BY observed_at DESC LIMIT 1",
);
if (last) {
  const at = Number(last.at_ms);
  const usage = (p: string): Usage => ({
    usage15: Number(last[`${p}usage_15min`]),
    usageDay: Number(last[`${p}usage_daily`]),
    limit15: Number(last[`${p}limit_15min`]),
    limitDay: Number(last[`${p}limit_daily`]),
    observedAt: at,
  });
  limiter.restore(usage(""), usage("read_"));
}
limiter.onSample((s) => {
  void db
    .run(
      `INSERT INTO rate_sample VALUES ($1::TIMESTAMPTZ, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        s.observedAt.toISOString(), s.method, s.path, s.status, s.priority,
        s.overall?.usage15 ?? null, s.overall?.usageDay ?? null, s.overall?.limit15 ?? null, s.overall?.limitDay ?? null,
        s.read?.usage15 ?? null, s.read?.usageDay ?? null, s.read?.limit15 ?? null, s.read?.limitDay ?? null,
      ],
    )
    .catch((err) => console.error("rate_sample insert failed:", err));
});

const snapshot = new SnapshotPublisher(db);
const engine = new SyncEngine(db, { onChange: () => snapshot.markDirty() });
setMirror(new Mirror(db, engine));

// Push subscription: needs the public callback URL (with a secret path) and HTTP transport.
const webhookUrl = process.env.STRAVA_WEBHOOK_URL ?? "";
const webhook = webhookUrl
  ? new StravaWebhook(db, engine, webhookUrl, {
      clientId: process.env.STRAVA_CLIENT_ID ?? "",
      clientSecret: process.env.STRAVA_CLIENT_SECRET ?? "",
    })
  : null;
if (webhook) engine.pushStatus = () => webhook.status();

const syncEnabled = (process.env.STRAVA_SYNC ?? "on").toLowerCase() !== "off";
if (syncEnabled) {
  engine.start();
  snapshot.start();
}

async function closeMirror(): Promise<void> {
  webhook?.stop();
  snapshot.stop();
  await engine.stop();
  db.close();
}

// ------------------------------------------------------------------ transports

const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "stdio") {
  serveStdio(createServer);
  console.error(`${SERVER_NAME} ${VERSION} running via stdio (mirror: ${dbPath}, sync ${syncEnabled ? "on" : "off"})`);
  const shutdown = async () => {
    await closeMirror();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 8000);
  // Hostnames clients may use in the Host header (DNS-rebinding protection). Unset
  // means any host, which is fine on a private network or behind a reverse proxy.
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = extraHosts.length
    ? ["localhost", "127.0.0.1", ...extraHosts]
    : undefined;

  const handler = createMcpHandler(createServer);
  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts });
  app.get("/health", (c) =>
    c.json({ status: "ok", name: SERVER_NAME, version: VERSION }),
  );

  const bearerMatches = (token: string, header: string | undefined): boolean => {
    const expected = Buffer.from(`Bearer ${token}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  // The read-only snapshot, for notebooks and dashboards. Disabled without a token.
  const snapshotToken = process.env.SNAPSHOT_TOKEN ?? "";
  app.on(["GET", "HEAD"], "/snapshot.duckdb", (c) => {
    if (!snapshotToken) return c.text("Snapshot serving is disabled (set SNAPSHOT_TOKEN)", 404);
    if (!bearerMatches(snapshotToken, c.req.header("authorization"))) return c.text("Unauthorized", 401);
    return snapshot.serve(c.req.raw);
  });

  // A small live export for other services (see docs/reference/export.md); same token.
  // /export/garmin-sync is the name it had in 4.2 and stays as an alias.
  app.on("GET", ["/export/sync", "/export/garmin-sync"], async (c) => {
    if (!snapshotToken) return c.text("Export is disabled (set SNAPSHOT_TOKEN)", 404);
    if (!bearerMatches(snapshotToken, c.req.header("authorization"))) return c.text("Unauthorized", 401);
    const raw = c.req.query("since");
    const since = raw ? new Date(raw) : null;
    if (since && Number.isNaN(since.getTime())) return c.text("since must be an ISO date or timestamp", 400);
    return c.json(await syncExport(db, since));
  });

  // Optional bearer for the MCP endpoint itself, for when the server shares a network
  // with callers that should reach only the snapshot.
  const mcpToken = process.env.MCP_BEARER_TOKEN ?? "";
  const mcp = (c: Context) => {
    if (mcpToken && !bearerMatches(mcpToken, c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
  };
  // Strava's webhook callback: public, authenticated by its secret path and the
  // subscription/athlete checks; events only queue re-fetches.
  if (webhook) {
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
  app.all("/mcp", mcp);
  app.all("/", mcp);

  const httpServer = serve(
    { fetch: app.fetch, port, hostname: "0.0.0.0" },
    (info) => {
      console.error(
        `${SERVER_NAME} ${VERSION} listening on http://0.0.0.0:${info.port}/mcp (mirror: ${dbPath}, sync ${syncEnabled ? "on" : "off"})`,
      );
      // Registration makes Strava call the callback, so it waits for the listener.
      if (webhook && syncEnabled) webhook.start();
    },
  );
  const shutdown = async () => {
    await handler.close();
    await closeMirror();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.error(
    `ERROR: MCP_TRANSPORT must be "stdio" or "http", got "${transport}".`,
  );
  process.exit(1);
}

// After the transport is up, so it never delays the first exchange.
if (!unitsFromEnv) void resolveUnitsFromProfile();
