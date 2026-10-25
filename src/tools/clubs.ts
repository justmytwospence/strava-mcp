import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { mirrorResult, pageOf } from "../format.js";
import { formatPaginationNote, paginationSchema } from "../pagination.js";
import { READ_ONLY } from "./annotations.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_athlete_clubs",
    {
      title: "List Athlete Clubs",
      description: "List clubs the authenticated athlete belongs to.",
      inputSchema: z.object({
        ...paginationSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ page, per_page }) => {
      try {
        const { data, meta } = await mirror().clubs();
        const clubs = pageOf(data as unknown[], page, per_page);
        const note = formatPaginationNote(clubs.length, page, per_page);
        return mirrorResult({ clubs, _pagination: note }, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_club",
    {
      title: "Get Club",
      description: "Get detailed information about a club including description, member count, and sport type.",
      inputSchema: z.object({
        club_id: z.coerce.number().int().describe("The club ID"),
      }),
      annotations: READ_ONLY,
    },
    async ({ club_id }) => {
      try {
        const { data, meta } = await mirror().club(String(club_id));
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
