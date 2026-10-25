import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { mirrorResult, pageOf } from "../format.js";
import { formatPaginationNote, paginationSchema } from "../pagination.js";
import { READ_ONLY } from "./annotations.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_authenticated_athlete",
    {
      title: "Get Authenticated Athlete",
      description:
        "Get the profile of the currently authenticated athlete, including name, location, stats summary, bikes, and shoes.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { data, meta } = await mirror().athlete();
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_athlete_zones",
    {
      title: "Get Athlete Zones",
      description: "Get the authenticated athlete's heart rate and power zones.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { data, meta } = await mirror().athleteZones();
        return mirrorResult(data, meta);
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
        "Get activity statistics for the authenticated athlete: recent, year-to-date, and all-time totals for runs, rides, and swims. Includes biggest ride distance and biggest climb.",
      inputSchema: z.object({
        athlete_id: z
          .coerce.number()
          .int()
          .optional()
          .describe("Ignored: Strava serves stats only for the authenticated athlete, which the mirror holds. Kept for compatibility."),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { data, meta } = await mirror().athleteStats();
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_starred_segments",
    {
      title: "List Starred Segments",
      description: "List segments starred by the authenticated athlete.",
      inputSchema: z.object({
        ...paginationSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ page, per_page }) => {
      try {
        const { data, meta } = await mirror().starredSegments();
        const segments = pageOf(data as unknown[], page, per_page);
        const note = formatPaginationNote(segments.length, page, per_page);
        return mirrorResult({ segments, _pagination: note }, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
