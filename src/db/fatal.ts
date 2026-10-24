/**
 * DuckDB invalidates the whole database after some failures (a rollback that could
 * not complete, an internal error, an out-of-memory during a checkpoint): every later
 * statement answers "database has been invalidated" and only restarting the process
 * helps. The server therefore exits non-zero on such an error, so that the container
 * runtime restarts it and the mirror recovers from the write-ahead log.
 */

const FATAL_PATTERNS: RegExp[] = [
  /\bFATAL\b/,
  /database has been invalidated/i,
  /cannot continue operation/i,
  /failed to (?:commit|rollback) transaction/i,
  /\bINTERNAL Error\b/,
];

/** Whether an error means the DuckDB instance can no longer be used. */
export function isFatalDatabaseError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return FATAL_PATTERNS.some((p) => p.test(message));
}

/** Exit status used when the database became unusable. */
export const FATAL_EXIT_CODE = 70;

/**
 * Exit the process if `err` is fatal for the database. `exit` is injectable for tests
 * and defaults to process.exit.
 */
export function exitOnFatalDatabaseError(err: unknown, context: string, exit: (code: number) => void = process.exit): void {
  if (!isFatalDatabaseError(err)) return;
  console.error(
    `${context}: the DuckDB database is no longer usable (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); exiting so that the service restarts and recovers.`,
  );
  exit(FATAL_EXIT_CODE);
}
