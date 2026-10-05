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

import { register as registerAthleteResources } from "./resources/athlete.js";
import { register as registerActivityResources } from "./resources/activities.js";
import { register as registerSegmentResources } from "./resources/segments.js";
import { register as registerRouteResources } from "./resources/routes.js";
import { register as registerReferenceResources } from "./resources/reference.js";

import { stravaGet } from "./strava-client.js";
import { setDefaultUnits } from "./format.js";
import type { DetailedAthlete } from "./types.js";

import { register as registerWeeklySummary } from "./prompts/weekly-summary.js";
import { register as registerActivityAnalysis } from "./prompts/activity-analysis.js";
import { register as registerTrainingPlanReview } from "./prompts/training-plan-review.js";
import { register as registerSegmentComparison } from "./prompts/segment-comparison.js";
import { register as registerRaceReadiness } from "./prompts/race-readiness.js";

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

/**
 * Apply an explicit STRAVA_UNITS override. Returns true if units were set.
 * Synchronous and network-free, so it is safe to call before connecting.
 */
function applyUnitsFromEnv(): boolean {
  const override = process.env.STRAVA_UNITS?.toLowerCase();
  if (override === "metric" || override === "imperial") {
    setDefaultUnits(override);
    return true;
  }
  return false;
}

/**
 * Best-effort fallback: derive units from the athlete's measurement_preference.
 * Runs after the transport is connected so it never delays the handshake or
 * tool listing. Failure is non-fatal and leaves the metric default in place.
 */
async function resolveUnitsFromProfile(): Promise<void> {
  try {
    const athlete = await stravaGet<DetailedAthlete>("/athlete");
    setDefaultUnits(
      athlete.measurement_preference === "feet" ? "imperial" : "metric",
    );
  } catch {
    // Keep the metric default if the profile cannot be fetched.
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

  registerAthleteResources(server);
  registerActivityResources(server);
  registerSegmentResources(server);
  registerRouteResources(server);
  registerReferenceResources(server);

  registerWeeklySummary(server);
  registerActivityAnalysis(server);
  registerTrainingPlanReview(server);
  registerSegmentComparison(server);
  registerRaceReadiness(server);

  const unitsFromEnv = applyUnitsFromEnv();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (!unitsFromEnv) {
    void resolveUnitsFromProfile();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
