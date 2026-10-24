import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FATAL_EXIT_CODE, exitOnFatalDatabaseError, isFatalDatabaseError } from "../src/db/fatal.js";

describe("fatal DuckDB errors", () => {
  test("recognizes the messages DuckDB uses once the database is unusable", () => {
    for (const m of [
      "FATAL Error: Failed to rollback transaction. Cannot continue operation",
      "Invalid Error: Database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again.",
      "INTERNAL Error: Attempted to access index 3 within vector of size 3",
      "Failed to commit transaction: out of memory",
    ]) {
      assert.equal(isFatalDatabaseError(new Error(m)), true, m);
    }
  });

  test("leaves ordinary errors alone", () => {
    for (const m of [
      "Constraint Error: Duplicate key",
      "Out of Memory Error: failed to allocate data of size 8.0 MiB",
      "Parser Error: syntax error at or near \"FROM\"",
      "Binder Error: Referenced column \"x\" not found",
      "INTERRUPT Error: Interrupted!",
    ]) {
      assert.equal(isFatalDatabaseError(new Error(m)), false, m);
    }
    assert.equal(isFatalDatabaseError("a string, not fatal"), false);
  });

  test("exits with the fatal status only for fatal errors", () => {
    const exits: number[] = [];
    const exit = (code: number) => void exits.push(code);
    exitOnFatalDatabaseError(new Error("Binder Error: nope"), "test", exit);
    assert.deepEqual(exits, []);
    const log = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      exitOnFatalDatabaseError(new Error("FATAL Error: Failed to rollback transaction. Cannot continue operation"), "sync", exit);
    } finally {
      console.error = log;
    }
    assert.deepEqual(exits, [FATAL_EXIT_CODE]);
    assert.match(logged[0]!, /^sync: the DuckDB database is no longer usable/);
  });
});
