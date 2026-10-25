import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { DEFAULT_TOKEN_FILE } from "./constants.js";
import { mirror } from "./context.js";
import { setDefaultUnits } from "./format.js";
import { register as registerActivityAnalysis } from "./prompts/activity-analysis.js";
import { register as registerRaceReadiness } from "./prompts/race-readiness.js";
import { register as registerSegmentComparison } from "./prompts/segment-comparison.js";
import { register as registerTrainingPlanReview } from "./prompts/training-plan-review.js";
import { register as registerWeeklySummary } from "./prompts/weekly-summary.js";
import { register as registerActivityResources } from "./resources/activities.js";
import { register as registerAthleteResources } from "./resources/athlete.js";
import { register as registerReferenceResources } from "./resources/reference.js";
import { register as registerRouteResources } from "./resources/routes.js";
import { register as registerSegmentResources } from "./resources/segments.js";
import { hasRefreshToken } from "./strava-client.js";
import { register as registerActivities } from "./tools/activities.js";
import { register as registerAthletes } from "./tools/athletes.js";
import { register as registerClubs } from "./tools/clubs.js";
import { register as registerGear } from "./tools/gear.js";
import { register as registerMirrorTools } from "./tools/mirror-tools.js";
import { register as registerRoutes } from "./tools/routes.js";
import { register as registerSegments } from "./tools/segments.js";
import { register as registerStreams } from "./tools/streams.js";
import { register as registerUploads } from "./tools/uploads.js";
import type { DetailedAthlete } from "./types.js";

export const SERVER_NAME = "strava-mcp-server";
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export function validateEnv(): void {
  const required = ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    console.error("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET from https://www.strava.com/settings/api.");
    process.exit(1);
  }

  if (!hasRefreshToken() && !process.env.STRAVA_ACCESS_TOKEN) {
    const file = process.env.STRAVA_TOKEN_FILE || DEFAULT_TOKEN_FILE;
    console.error(
      `No Strava tokens: ${file} has no refresh token and STRAVA_REFRESH_TOKEN is unset. Run strava-mcp-auth once to authorize (with Compose: docker compose run --rm -p 8765:8765 strava-mcp auth).`,
    );
    process.exit(1);
  }
}

/**
 * Apply an explicit STRAVA_UNITS override. Returns true if units were set.
 * Synchronous and network-free, so it is safe to call before connecting.
 */
export function applyUnitsFromEnv(): boolean {
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
export async function resolveUnitsFromProfile(): Promise<void> {
  try {
    const athlete = (await mirror().athlete()).data as DetailedAthlete;
    setDefaultUnits(athlete.measurement_preference === "feet" ? "imperial" : "metric");
  } catch {
    // Keep the metric default if the profile cannot be fetched.
  }
}

/**
 * Builds a fully registered server. The HTTP transport calls this once per
 * request, stdio once per process, so keep it free of side effects and I/O.
 * Shared state (tokens, unit preference) lives at module scope.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  registerActivities(server);
  registerAthletes(server);
  registerClubs(server);
  registerGear(server);
  registerRoutes(server);
  registerSegments(server);
  registerStreams(server);
  registerUploads(server);
  registerMirrorTools(server);

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

  return server;
}
