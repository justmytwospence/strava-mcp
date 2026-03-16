import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stravaGet } from "../strava-client.js";
import type { DetailedAthlete, AthleteStats } from "../types.js";

export function register(server: McpServer): void {
  server.registerResource(
    "athlete-profile",
    "strava://athlete/profile",
    {
      description:
        "Current authenticated athlete profile including name, location, bikes, and shoes.",
      mimeType: "application/json",
    },
    async (uri) => {
      const athlete = await stravaGet<DetailedAthlete>("/athlete");
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(athlete, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  server.registerResource(
    "athlete-stats",
    "strava://athlete/stats",
    {
      description:
        "Year-to-date and all-time activity totals for runs, rides, and swims.",
      mimeType: "application/json",
    },
    async (uri) => {
      const athlete = await stravaGet<DetailedAthlete>("/athlete");
      const stats = await stravaGet<AthleteStats>(
        `/athletes/${athlete.id}/stats`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(stats, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
