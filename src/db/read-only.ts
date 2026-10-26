import { type DuckDBConnection, type DuckDBPreparedStatement, StatementType } from "@duckdb/node-api";
import { exitOnFatalDatabaseError } from "./fatal.js";

/** One serialized, engine-enforced read-only connection per mirror, never the writer. */
export class ReadOnlyQuery {
  private connection: DuckDBConnection | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly connect: () => Promise<DuckDBConnection>) {}

  run(sql: string, maxRows: number, timeoutMs = 30_000) {
    const result = this.tail.then(() => this.execute(sql, maxRows, timeoutMs));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async execute(sql: string, maxRows: number, timeoutMs: number) {
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) throw new Error("max_rows must be 1-5000.");
    this.connection ??= await this.connect();
    const conn = this.connection;
    let result: { columns: string[]; rows: unknown[]; truncated: boolean } | undefined;
    let failure: unknown;
    let begun = false;
    let prepared: DuckDBPreparedStatement | undefined;
    const timer = setTimeout(() => conn.interrupt(), timeoutMs);
    try {
      // Preparation can itself execute work (e.g. binding side-effecting functions).
      // StatementType.EXPLAIN includes EXPLAIN ANALYZE mutations; it is NOT a safety boundary.
      await conn.run("BEGIN TRANSACTION READ ONLY");
      begun = true;
      const extracted = await conn.extractStatements(sql);
      if (extracted.count !== 1) throw new Error(`Send exactly one statement (got ${extracted.count}).`);
      prepared = await extracted.prepare(0);
      if (prepared.statementType !== StatementType.SELECT && prepared.statementType !== StatementType.EXPLAIN) {
        throw new Error(`Only read-only queries are allowed (got ${StatementType[prepared.statementType]}).`);
      }
      const reader = await prepared.runAndReadUntil(maxRows + 1);
      const rows = reader.getRowObjectsJson();
      result = { columns: reader.columnNames(), rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
    } catch (err) {
      exitOnFatalDatabaseError(err, "query");
      failure = err;
    } finally {
      clearTimeout(timer);
    }
    const cleanupErrors: unknown[] = [];
    try {
      prepared?.destroySync();
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      if (begun) await conn.run("ROLLBACK");
      else this.close(); // Unsupported read-only transactions must fail closed.
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length) {
      // Never reuse a connection whose transaction state is uncertain; retain the original failure too.
      this.close();
      throw new AggregateError(
        [failure, ...cleanupErrors],
        "Read-only query cleanup/rollback failed; connection discarded.",
      );
    }
    if (!result) throw failure;
    return result;
  }

  close(): void {
    const conn = this.connection;
    this.connection = null;
    conn?.closeSync();
  }
}
