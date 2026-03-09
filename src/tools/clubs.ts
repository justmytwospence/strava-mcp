import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";
import type {
  SummaryClub,
  DetailedClub,
  SummaryActivity,
  SummaryAthlete,
} from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_athlete_clubs",
    {
      title: "List Athlete Clubs",
      description:
        "List clubs the authenticated athlete belongs to.",
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
        const clubs = await stravaGet<SummaryClub[]>("/athlete/clubs", {
          page,
          per_page,
        });
        const note = formatPaginationNote(clubs.length, page, per_page);
        return jsonResult({ clubs, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_club",
    {
      title: "Get Club",
      description:
        "Get detailed information about a club including description, member count, and sport type.",
      inputSchema: {
        club_id: z.coerce.number().int().describe("The club ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ club_id }: { club_id: number }) => {
      try {
        const club = await stravaGet<DetailedClub>(`/clubs/${club_id}`);
        return jsonResult(club);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_club_activities",
    {
      title: "List Club Activities",
      description:
        "List recent activities by members of a club. Only includes activities set to 'Everyone' visibility.",
      inputSchema: {
        club_id: z.coerce.number().int().describe("The club ID"),
        ...paginationSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      club_id,
      page,
      per_page,
    }: {
      club_id: number;
      page: number;
      per_page: number;
    }) => {
      try {
        const activities = await stravaGet<SummaryActivity[]>(
          `/clubs/${club_id}/activities`,
          { page, per_page },
        );
        const note = formatPaginationNote(activities.length, page, per_page);
        return jsonResult({ activities, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_club_members",
    {
      title: "List Club Members",
      description: "List members of a club.",
      inputSchema: {
        club_id: z.coerce.number().int().describe("The club ID"),
        ...paginationSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      club_id,
      page,
      per_page,
    }: {
      club_id: number;
      page: number;
      per_page: number;
    }) => {
      try {
        const members = await stravaGet<SummaryAthlete[]>(
          `/clubs/${club_id}/members`,
          { page, per_page },
        );
        const note = formatPaginationNote(members.length, page, per_page);
        return jsonResult({ members, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_club_admins",
    {
      title: "List Club Admins",
      description: "List admins of a club.",
      inputSchema: {
        club_id: z.coerce.number().int().describe("The club ID"),
        ...paginationSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      club_id,
      page,
      per_page,
    }: {
      club_id: number;
      page: number;
      per_page: number;
    }) => {
      try {
        const admins = await stravaGet<SummaryAthlete[]>(
          `/clubs/${club_id}/admins`,
          { page, per_page },
        );
        const note = formatPaginationNote(admins.length, page, per_page);
        return jsonResult({ admins, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
