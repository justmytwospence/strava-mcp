import type { McpServer } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";
import type { AthleteStats, DetailedAthlete } from "../types.js";

export function register(server: McpServer): void {
  server.registerResource(
    "athlete-profile",
    "strava://athlete/profile",
    {
      description: "Current authenticated athlete profile including name, location, bikes, and shoes.",
      mimeType: "application/json",
    },
    async (uri) => {
      const athlete = (await mirror().athlete()).data as DetailedAthlete;
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
      description: "Year-to-date and all-time activity totals for runs, rides, and swims.",
      mimeType: "application/json",
    },
    async (uri) => {
      const stats = (await mirror().athleteStats()).data as AthleteStats;
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
