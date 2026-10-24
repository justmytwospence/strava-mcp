/**
 * Peak-memory benchmark for the operations that read the raw store.
 *
 *   npm run build
 *   DUCKDB_MEMORY_LIMIT=512MB node scripts/bench-memory.ts <operation> <mirror.duckdb>
 *
 * Operations: open (migrate only), drift, plan, project-streams (re-project the longest
 * activity's streams), read-streams (the tool's read path), snapshot (publish a copy).
 * Each run is one process, so the reported maximum RSS belongs to that operation alone.
 * Run it on a copy: the mirror is opened for writing and migrated. It imports the
 * compiled code so that it also runs inside the Docker image (Alpine, musl), where the
 * numbers that matter are measured.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../dist/db/database.js";
import { drift, project } from "../dist/db/projections.js";
import { current } from "../dist/db/raw.js";
import { SnapshotPublisher } from "../dist/snapshot.js";
import { SyncEngine } from "../dist/sync/engine.js";

const [operation, path] = process.argv.slice(2);
if (!operation || !path) {
  console.error("usage: bench-memory.ts <open|drift|plan|project-streams|read-streams|snapshot> <mirror.duckdb>");
  process.exit(2);
}

const snapshotDir = mkdtempSync(join(tmpdir(), "strava-bench-"));
const started = performance.now();
const db = await Database.open({
  path,
  snapshotDir,
  memoryLimit: process.env.DUCKDB_MEMORY_LIMIT,
  threads: process.env.DUCKDB_THREADS ? Number(process.env.DUCKDB_THREADS) : undefined,
});
const opened = performance.now();

let detail = "";
switch (operation) {
  case "open":
    break;
  case "drift": {
    const rows = await db.write((tx) => drift(tx));
    detail = `${rows.length} unmapped keys`;
    break;
  }
  case "plan": {
    const n = await new SyncEngine(db).plan();
    detail = `${n} jobs added`;
    break;
  }
  case "project-streams": {
    const key = await largestStreamKey();
    await db.transaction((tx) => project(tx, "activity_streams", [key]));
    detail = `activity ${key}`;
    break;
  }
  case "read-streams": {
    const key = await largestStreamKey();
    const row = await db.write((tx) => current(tx, "activity_streams", key));
    detail = `activity ${key}, ${((row?.body?.length ?? 0) / 1e6).toFixed(1)} MB of JSON`;
    break;
  }
  case "snapshot": {
    await new SnapshotPublisher(db).publish();
    break;
  }
  default:
    console.error(`unknown operation ${operation}`);
    process.exit(2);
}
const finished = performance.now();
db.close();
rmSync(snapshotDir, { recursive: true, force: true });

console.log(
  JSON.stringify({
    operation,
    memory_limit: process.env.DUCKDB_MEMORY_LIMIT ?? "default",
    open_ms: Math.round(opened - started),
    run_ms: Math.round(finished - opened),
    peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
    detail,
  }),
);

/** The longest activity, from the typed metadata (measuring the bodies would itself scan them all). */
async function largestStreamKey(): Promise<string> {
  const row = await db.one<{ k: string }>(
    `SELECT activity_id::VARCHAR AS k FROM activity_stream_meta ORDER BY original_size DESC LIMIT 1`,
  );
  if (!row) throw new Error("no activity streams in this mirror");
  return row.k;
}
