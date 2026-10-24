/**
 * The DuckDB mirror: one file, owned by this process.
 *
 * DuckDB allows a single writing process, so the sync worker and the MCP tools share
 * this instance. Writes go through one connection behind a mutex (a node-api
 * connection must not run two statements at once); the read-only `query` tool gets its
 * own connection, which MVCC lets run alongside the writer.
 *
 * File access is locked down once the schema is in place: no file or URL is reachable
 * from SQL, so a `query` cannot read the token file.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DuckDBConnection,
  DuckDBInstance,
  type DuckDBValue,
} from "@duckdb/node-api";
import { MIGRATIONS } from "./schema.js";

export type Row = Record<string, unknown>;

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface DatabaseOptions {
  path: string;
  snapshotDir: string;
  memoryLimit?: string;
  threads?: number;
}

export class Database {
  private writeMutex = new Mutex();

  private constructor(
    readonly instance: DuckDBInstance,
    private readonly writer: DuckDBConnection,
    readonly options: DatabaseOptions,
  ) {}

  static async open(options: DatabaseOptions): Promise<Database> {
    const path = options.path === ":memory:" ? ":memory:" : resolve(options.path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const snapshotDir = resolve(options.snapshotDir);
    mkdirSync(snapshotDir, { recursive: true });
    const instance = await DuckDBInstance.create(path);
    const writer = await instance.connect();
    await writer.run("SET GLOBAL TimeZone = 'UTC'");
    if (options.memoryLimit) await writer.run(`SET memory_limit = '${options.memoryLimit}'`);
    if (options.threads) await writer.run(`SET threads = ${options.threads}`);
    if (path !== ":memory:") {
      const tmp = join(dirname(path), "duckdb-tmp");
      mkdirSync(tmp, { recursive: true });
      await writer.run(`SET temp_directory = '${tmp}'`);
    }
    const db = new Database(instance, writer, { ...options, path, snapshotDir });
    await db.migrate();
    // From here on SQL cannot touch files or the network, and cannot undo that.
    await writer.run("SET enable_external_access = false");
    await writer.run("SET lock_configuration = true");
    return db;
  }

  private async migrate(): Promise<void> {
    await this.writer.run(
      "CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())",
    );
    const applied = new Set(
      (await this.all<{ version: number }>("SELECT version FROM schema_migration")).map((r) => Number(r.version)),
    );
    for (const [index, migration] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (applied.has(version)) continue;
      const tx = new Tx(this.writer);
      try {
        if (Array.isArray(migration)) {
          await this.writer.run("BEGIN TRANSACTION");
          try {
            for (const step of migration) {
              if (typeof step === "string") await this.writer.run(step);
              else await step(tx);
            }
            await this.writer.run("INSERT INTO schema_migration (version) VALUES ($1)", [version]);
            await this.writer.run("COMMIT");
          } catch (err) {
            await this.writer.run("ROLLBACK").catch(() => undefined);
            throw err;
          }
        } else {
          // Commits on its own and tolerates being run again after an interruption.
          await migration.resumable(tx);
          await this.writer.run("INSERT INTO schema_migration (version) VALUES ($1)", [version]);
        }
      } catch (err) {
        throw new Error(`Migration ${version} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Run statements on the writer connection, serialized with every other write. */
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.writeMutex.run(() => fn(new Tx(this.writer)));
  }

  /** Run fn in a transaction on the writer connection. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.write(async (tx) => {
      await tx.run("BEGIN TRANSACTION");
      try {
        const result = await fn(tx);
        await tx.run("COMMIT");
        return result;
      } catch (err) {
        await tx.run("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
  }

  /** A read on the writer connection (serialized), returning plain JS row objects. */
  all<T = Row>(sql: string, params?: DuckDBValue[]): Promise<T[]> {
    return this.write((tx) => tx.all<T>(sql, params));
  }

  async one<T = Row>(sql: string, params?: DuckDBValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  run(sql: string, params?: DuckDBValue[]): Promise<void> {
    return this.write((tx) => tx.run(sql, params));
  }

  /** A separate connection, for the read-only query tool. */
  connect(): Promise<DuckDBConnection> {
    return this.instance.connect();
  }

  /** The catalog name of the mirror (the file's basename), for COPY FROM DATABASE. */
  async catalog(): Promise<string> {
    const row = await this.one<{ db: string }>("SELECT current_database() AS db");
    return row!.db;
  }

  close(): void {
    this.writer.closeSync();
    this.instance.closeSync();
  }
}

export class Tx {
  constructor(private readonly conn: DuckDBConnection) {}

  async run(sql: string, params?: DuckDBValue[]): Promise<void> {
    await this.conn.run(sql, params);
  }

  async all<T = Row>(sql: string, params?: DuckDBValue[]): Promise<T[]> {
    // JSON-safe conversion: BIGINT, timestamps and decimals come back as strings,
    // so rows serialize without BigInt errors and 64-bit ids keep their precision.
    const reader = await this.conn.runAndReadAll(sql, params);
    return reader.getRowObjectsJson() as T[];
  }

  async one<T = Row>(sql: string, params?: DuckDBValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
}
