#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { register as registerActivities } from "./tools/activities.js";
import { register as registerAthletes } from "./tools/athletes.js";
import { register as registerClubs } from "./tools/clubs.js";
import { register as registerGear } from "./tools/gear.js";
import { register as registerRoutes } from "./tools/routes.js";
import { register as registerSegments } from "./tools/segments.js";
import { register as registerStreams } from "./tools/streams.js";
import { register as registerUploads } from "./tools/uploads.js";

function validateEnv(): void {
  const required = ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error(
      "Set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_ACCESS_TOKEN, and STRAVA_REFRESH_TOKEN.",
    );
    process.exit(1);
  }

  if (!process.env.STRAVA_ACCESS_TOKEN && !process.env.STRAVA_REFRESH_TOKEN) {
    console.error(
      "At least one of STRAVA_ACCESS_TOKEN or STRAVA_REFRESH_TOKEN must be set.",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  validateEnv();

  const server = new McpServer({
    name: "strava-mcp-server",
    version: "1.0.0",
  });

  registerActivities(server);
  registerAthletes(server);
  registerClubs(server);
  registerGear(server);
  registerRoutes(server);
  registerSegments(server);
  registerStreams(server);
  registerUploads(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
