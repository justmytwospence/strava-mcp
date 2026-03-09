import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet, stravaPost, stravaPut } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";
import { SPORT_TYPES } from "../constants.js";
import type {
  SummaryActivity,
  DetailedActivity,
  Comment,
  SummaryAthlete,
  Lap,
  ActivityZone,
} from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_activities",
    {
      title: "List Athlete Activities",
      description:
        "List the authenticated athlete's activities. Supports filtering by date range and pagination.",
      inputSchema: {
        before: z
          .coerce.number()
          .int()
          .optional()
          .describe("Only activities before this epoch timestamp (seconds)"),
        after: z
          .coerce.number()
          .int()
          .optional()
          .describe("Only activities after this epoch timestamp (seconds)"),
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
      before,
      after,
      page,
      per_page,
    }: {
      before?: number;
      after?: number;
      page: number;
      per_page: number;
    }) => {
      try {
        const activities = await stravaGet<SummaryActivity[]>(
          "/athlete/activities",
          { before, after, page, per_page },
        );
        const note = formatPaginationNote(activities.length, page, per_page);
        return jsonResult({ activities, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_activity",
    {
      title: "Get Activity",
      description:
        "Get detailed information about a specific activity including description, calories, splits, laps, segment efforts, and gear.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID"),
        include_all_efforts: z
          .boolean()
          .default(false)
          .describe("Include all segment efforts (can be very large). Default false."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      activity_id,
      include_all_efforts,
    }: {
      activity_id: number;
      include_all_efforts: boolean;
    }) => {
      try {
        const activity = await stravaGet<DetailedActivity>(
          `/activities/${activity_id}`,
          { include_all_efforts },
        );
        return jsonResult(activity);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_create_activity",
    {
      title: "Create Activity",
      description:
        "Create a manual activity entry. Requires activity:write scope.",
      inputSchema: {
        name: z.string().describe("The name of the activity"),
        sport_type: z.enum(SPORT_TYPES).describe("The sport type (e.g. Run, Ride, Swim, Hike)"),
        start_date_local: z
          .string()
          .describe("ISO 8601 date/time for activity start in local timezone (e.g. 2024-01-15T08:30:00Z)"),
        elapsed_time: z
          .coerce.number()
          .int()
          .min(1)
          .describe("Total elapsed time in seconds"),
        description: z.string().optional().describe("Activity description"),
        distance: z
          .coerce.number()
          .min(0)
          .optional()
          .describe("Distance in meters"),
        trainer: z
          .boolean()
          .optional()
          .describe("Whether this was a trainer/indoor activity"),
        commute: z
          .boolean()
          .optional()
          .describe("Whether this was a commute"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: {
      name: string;
      sport_type: string;
      start_date_local: string;
      elapsed_time: number;
      description?: string;
      distance?: number;
      trainer?: boolean;
      commute?: boolean;
    }) => {
      try {
        const activity = await stravaPost<DetailedActivity>(
          "/activities",
          params,
        );
        return jsonResult(activity);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_update_activity",
    {
      title: "Update Activity",
      description:
        "Update an activity's mutable properties. Requires activity:write scope. Only provided fields are updated.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID to update"),
        name: z.string().optional().describe("New name"),
        sport_type: z.enum(SPORT_TYPES).optional().describe("New sport type"),
        description: z.string().optional().describe("New description"),
        gear_id: z
          .string()
          .optional()
          .describe('Gear ID to associate (e.g. "b12345"), or "none" to remove'),
        trainer: z.boolean().optional().describe("Whether this is a trainer activity"),
        commute: z.boolean().optional().describe("Whether this is a commute"),
        hide_from_home: z
          .boolean()
          .optional()
          .describe("Whether to mute this activity in the feed"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      activity_id,
      ...updates
    }: {
      activity_id: number;
      name?: string;
      sport_type?: string;
      description?: string;
      gear_id?: string;
      trainer?: boolean;
      commute?: boolean;
      hide_from_home?: boolean;
    }) => {
      try {
        const activity = await stravaPut<DetailedActivity>(
          `/activities/${activity_id}`,
          updates,
        );
        return jsonResult(activity);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_activity_comments",
    {
      title: "List Activity Comments",
      description: "List comments on an activity.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID"),
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
      activity_id,
      page,
      per_page,
    }: {
      activity_id: number;
      page: number;
      per_page: number;
    }) => {
      try {
        const comments = await stravaGet<Comment[]>(
          `/activities/${activity_id}/comments`,
          { page, per_page },
        );
        const note = formatPaginationNote(comments.length, page, per_page);
        return jsonResult({ comments, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_activity_kudoers",
    {
      title: "List Activity Kudoers",
      description: "List athletes who gave kudos on an activity.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID"),
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
      activity_id,
      page,
      per_page,
    }: {
      activity_id: number;
      page: number;
      per_page: number;
    }) => {
      try {
        const kudoers = await stravaGet<SummaryAthlete[]>(
          `/activities/${activity_id}/kudos`,
          { page, per_page },
        );
        const note = formatPaginationNote(kudoers.length, page, per_page);
        return jsonResult({ kudoers, _pagination: note });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_activity_laps",
    {
      title: "List Activity Laps",
      description:
        "List laps of an activity. Each lap includes distance, time, speed, heart rate, watts, and elevation.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ activity_id }: { activity_id: number }) => {
      try {
        const laps = await stravaGet<Lap[]>(
          `/activities/${activity_id}/laps`,
        );
        return jsonResult(laps);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_activity_zones",
    {
      title: "List Activity Zones",
      description:
        "Get heart rate and power zone distribution for an activity. Shows time spent in each zone.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ activity_id }: { activity_id: number }) => {
      try {
        const zones = await stravaGet<ActivityZone[]>(
          `/activities/${activity_id}/zones`,
        );
        return jsonResult(zones);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
