#!/usr/bin/env node
// The strava-mcp-auth command (package.json bin); `strava-mcp-server auth` is the same.
import { main } from "./auth.js";

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
