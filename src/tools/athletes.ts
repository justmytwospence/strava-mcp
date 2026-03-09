import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import type {
  DetailedAthlete,
  AthleteZones,
  AthleteStats,
  SummarySegment,
} from "../types.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_authenticated_athlete",
    {
      title: "Get Authenticated Athlete",
      description:
        "Get the profile of the currently authenticated athlete, including name, location, stats summary, bikes, and shoes.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const athlete = await stravaGet<DetailedAthlete>("/athlete");
        return jsonResult(athlete);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_athlete_zones",
    {
      title: "Get Athlete Zones",
      description:
        "Get the authenticated athlete's heart rate and power zones.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const zones = await stravaGet<AthleteZones>("/athlete/zones");
        return jsonResult(zones);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_athlete_stats",
    {
      title: "Get Athlete Stats",
      description:
        "Get activity statistics for an athlete: recent, year-to-date, and all-time totals for runs, rides, and swims. Includes biggest ride distance and biggest climb.",
      inputSchema: {
        athlete_id: z
          .coerce.number()
          .int()
          .describe("The athlete ID. Use the authenticated athlete's ID from strava_get_authenticated_athlete."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ athlete_id }: { athlete_id: number }) => {
      try {
        const stats = await stravaGet<AthleteStats>(
          `/athletes/${athlete_id}/stats`,
        );
        return jsonResult(stats);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_starred_segments",
    {
      title: "List Starred Segments",
      description:
        "List segments starred by the authenticated athlete.",
      inputSchema: {
        ...paginationSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ page, per_page }: { page: number; per_page: number }) => {
      try {
        const segments = await stravaGet<SummarySegment[]>(
          "/segments/starred",
          { page, per_page },
        );
        const note = formatPaginationNote(segments.length, page, per_page);
        return jsonResult({ segments, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
