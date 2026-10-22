/**
 * Read-only snapshots of the mirror for other readers (notebooks, dashboards, backups).
 *
 * DuckDB lets only one process open the live file, so after changes the whole
 * database is copied (COPY FROM DATABASE, a consistent copy taken under the write
 * lock) into a new file that atomically replaces the previous snapshot. Readers attach
 * it, locally or over HTTP:
 *
 *   ATTACH 'http://strava-mcp:8000/snapshot.duckdb' AS strava (READ_ONLY);
 */
import { createReadStream, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Database } from "./db/database.js";

const HOUR = 3_600_000;

export class SnapshotPublisher {
  private dirty = true;
  private lastPublished = 0;
  private timer: NodeJS.Timeout | null = null;
  readonly path: string;

  constructor(
    private readonly db: Database,
    readonly name = "strava.duckdb",
    /** Minimum time between snapshots while the sync is idle, and while it backfills. */
    private readonly intervals = { idle: HOUR, backfilling: 6 * HOUR },
  ) {
    this.path = join(db.options.snapshotDir, name);
    if (existsSync(this.path)) this.lastPublished = statSync(this.path).mtimeMs;
  }

  markDirty(): void {
    this.dirty = true;
  }

  async publish(): Promise<void> {
    const tmp = `${this.path}.tmp`;
    rmSync(tmp, { force: true });
    const catalog = await this.db.catalog();
    await this.db.write(async (tx) => {
      await tx.run(`ATTACH '${tmp}' AS snapshot_target`);
      try {
        await tx.run(`COPY FROM DATABASE "${catalog}" TO snapshot_target`);
      } finally {
        await tx.run("DETACH snapshot_target");
      }
    });
    renameSync(tmp, this.path);
    this.dirty = false;
    this.lastPublished = Date.now();
  }

  private async due(): Promise<boolean> {
    if (!this.dirty) return false;
    const backlog = await this.db.one<{ n: number }>("SELECT count(*)::INTEGER AS n FROM sync_job WHERE priority >= 20");
    const interval = (backlog?.n ?? 0) > 0 ? this.intervals.backfilling : this.intervals.idle;
    return Date.now() - this.lastPublished >= interval;
  }

  start(): void {
    const tick = async () => {
      try {
        if (await this.due()) await this.publish();
      } catch (err) {
        console.error("snapshot: publish failed:", err);
      }
    };
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Serve the snapshot with HEAD and Range support (DuckDB's httpfs reads it in ranges).
   * Returns 404 until the first snapshot exists.
   */
  serve(req: Request): Response {
    if (!existsSync(this.path)) return new Response("No snapshot yet", { status: 404 });
    const size = statSync(this.path).size;
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "content-type": "application/octet-stream",
      "last-modified": new Date(statSync(this.path).mtimeMs).toUTCString(),
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      if (range[1] === "" && range[2] !== "") {
        start = Math.max(0, size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== "") end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = String(end - start + 1);
    if (req.method === "HEAD") return new Response(null, { status, headers });
    const stream = Readable.toWeb(createReadStream(this.path, { start, end })) as ReadableStream;
    return new Response(stream, { status, headers });
  }
}
