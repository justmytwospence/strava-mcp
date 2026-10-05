#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  applyUnitsFromEnv,
  createServer,
  resolveUnitsFromProfile,
  SERVER_NAME,
  validateEnv,
  VERSION,
} from "./server.js";

validateEnv();
const unitsFromEnv = applyUnitsFromEnv();

serveStdio(createServer);
console.error(`${SERVER_NAME} ${VERSION} running via stdio`);

// After the transport is up, so it never delays the first exchange.
if (!unitsFromEnv) void resolveUnitsFromProfile();
