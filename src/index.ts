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
import { limiter } from "./strava-client.js";
import { SyncEngine } from "./sync/engine.js";
import type { Usage } from "./sync/rate-limit.js";

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

const syncEnabled = (process.env.STRAVA_SYNC ?? "on").toLowerCase() !== "off";
if (syncEnabled) {
  engine.start();
  snapshot.start();
}

async function closeMirror(): Promise<void> {
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

  // The read-only snapshot, for notebooks and dashboards. Disabled without a token.
  const snapshotToken = process.env.SNAPSHOT_TOKEN ?? "";
  const authorized = (header: string | undefined): boolean => {
    const expected = Buffer.from(`Bearer ${snapshotToken}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  app.on(["GET", "HEAD"], "/snapshot.duckdb", (c) => {
    if (!snapshotToken) return c.text("Snapshot serving is disabled (set SNAPSHOT_TOKEN)", 404);
    if (!authorized(c.req.header("authorization"))) return c.text("Unauthorized", 401);
    return snapshot.serve(c.req.raw);
  });

  const mcp = (c: Context) =>
    handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
  app.all("/mcp", mcp);
  app.all("/", mcp);

  const httpServer = serve(
    { fetch: app.fetch, port, hostname: "0.0.0.0" },
    (info) =>
      console.error(
        `${SERVER_NAME} ${VERSION} listening on http://0.0.0.0:${info.port}/mcp (mirror: ${dbPath}, sync ${syncEnabled ? "on" : "off"})`,
      ),
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
