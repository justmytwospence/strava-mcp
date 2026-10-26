import type { McpServer } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";
import { resourceResult } from "./result.js";

export function register(server: McpServer): void {
  server.registerResource(
    "athlete-profile",
    "strava://athlete/profile",
    {
      title: "Athlete Profile",
      description:
        "Authenticated athlete profile, bikes and shoes, with provenance. Cache-first; refresh costs one API request.",
      mimeType: "application/json",
    },
    async (uri) => resourceResult(uri, await mirror().athlete()),
  );
  server.registerResource(
    "athlete-stats",
    "strava://athlete/stats",
    {
      title: "Athlete Totals",
      description:
        "Year-to-date/all-time run, ride and swim totals with provenance. Cache-first; refresh costs one API request.",
      mimeType: "application/json",
    },
    async (uri) => resourceResult(uri, await mirror().athleteStats()),
  );
}
