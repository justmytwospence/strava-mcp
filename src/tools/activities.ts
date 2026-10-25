import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { jsonResult, mirrorResult, pageOf } from "../format.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";
import { SPORT_TYPES } from "../constants.js";
import type { DetailedActivity } from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_activities",
    {
      title: "List Athlete Activities",
      description:
        "List the authenticated athlete's activities, newest first. Supports filtering by date range and pagination. Served from the local mirror (refreshed from Strava at most every 15 minutes).",
      inputSchema: z.object({
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
      }),
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
        const { data: activities, meta } = await mirror().listActivities({ before, after, page, perPage: per_page });
        const note = formatPaginationNote(activities.length, page, per_page);
        return mirrorResult({ activities, _pagination: note }, meta);
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
        "Get detailed information about a specific activity including description, calories, splits, laps, segment efforts, best efforts, and gear. Served from the local mirror; recent activities are refreshed from Strava.",
      inputSchema: z.object({
        activity_id: z.coerce.number().int().describe("The activity ID"),
        include_all_efforts: z
          .boolean()
          .optional()
          .describe("Ignored: the mirror stores every segment effort and always returns them all. Kept for compatibility."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ activity_id }: { activity_id: number; include_all_efforts?: boolean }) => {
      try {
        const { data, meta } = await mirror().activity(String(activity_id));
        return mirrorResult(data, meta);
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
      inputSchema: z.object({
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
      }),
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
        const m = mirror();
        const activity = (await m.write("POST", "/activities", params, { type: "activity_detail" })) as DetailedActivity;
        await m.engine.enqueue("list_recent", "self", 5);
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
      inputSchema: z.object({
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
      }),
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
        const m = mirror();
        const activity = await m.write("PUT", `/activities/${activity_id}`, updates, { type: "activity_detail" });
        // The update response may omit efforts; refetch the full detail in the background.
        await m.engine.enqueue("activity_detail", String(activity_id), 5);
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
      inputSchema: z.object({
        activity_id: z.coerce.number().int().describe("The activity ID"),
        ...paginationSchema,
      }),
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
        const { data, meta } = await mirror().activityComments(String(activity_id));
        const comments = pageOf(data as unknown[], page, per_page);
        const note = formatPaginationNote(comments.length, page, per_page);
        return mirrorResult({ comments, _pagination: note }, meta);
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
      inputSchema: z.object({
        activity_id: z.coerce.number().int().describe("The activity ID"),
        ...paginationSchema,
      }),
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
        const { data, meta } = await mirror().activityKudos(String(activity_id));
        const kudoers = pageOf(data as unknown[], page, per_page);
        const note = formatPaginationNote(kudoers.length, page, per_page);
        return mirrorResult({ kudoers, _pagination: note }, meta);
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
      inputSchema: z.object({
        activity_id: z.coerce.number().int().describe("The activity ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ activity_id }: { activity_id: number }) => {
      try {
        // Laps are part of the activity detail, so this costs no separate request.
        const { data, meta } = await mirror().activity(String(activity_id));
        return mirrorResult((data as { laps?: unknown[] }).laps ?? [], meta);
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
      inputSchema: z.object({
        activity_id: z.coerce.number().int().describe("The activity ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ activity_id }: { activity_id: number }) => {
      try {
        const { data, meta } = await mirror().activityZones(String(activity_id));
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
