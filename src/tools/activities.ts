import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SPORT_TYPES } from "../constants.js";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { jsonResult, mirrorResult, pageOf } from "../format.js";
import { formatPaginationNote, paginationSchema } from "../pagination.js";
import { gearId, isoDateTime, numericId, orderedWindow } from "../validation.js";
import { CREATE, READ_ONLY, UPDATE } from "./annotations.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_activities",
    {
      title: "List Athlete Activities",
      description:
        "List the authenticated athlete's activities, newest first. Supports filtering by date range and pagination. Served from stored history, which can be incomplete during backfill. A stale listing refresh traverses upstream pages; local page size does not cap API requests. Check strava_sync_status or strava://mirror/budget before broad refreshes; narrow dates/use local SQL first.",
      inputSchema: z.object({
        before: z.coerce
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only activities before this epoch timestamp (seconds)"),
        after: z.coerce
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only activities after this epoch timestamp (seconds)"),
        ...paginationSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ before, after, page, per_page }) => {
      try {
        orderedWindow(after, before);
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
        activity_id: numericId.describe("The activity ID"),
        include_all_efforts: z
          .boolean()
          .optional()
          .describe(
            "Ignored: the mirror stores every segment effort and always returns them all. Kept for compatibility.",
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) => {
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
        "Create a manual activity entry (one API request). Requires activity:write scope and intent. Do not blindly retry a lost response; duplicate creation is possible.",
      inputSchema: z.object({
        name: z.string().min(1).max(1000).describe("The name of the activity"),
        sport_type: z.enum(SPORT_TYPES).describe("The sport type (e.g. Run, Ride, Swim, Hike)"),
        start_date_local: isoDateTime.describe(
          "ISO 8601 date/time for activity start in local timezone (e.g. 2024-01-15T08:30:00Z)",
        ),
        elapsed_time: z.coerce.number().int().min(1).describe("Total elapsed time in seconds"),
        description: z.string().optional().describe("Activity description"),
        distance: z.coerce.number().min(0).optional().describe("Distance in meters"),
        trainer: z.boolean().optional().describe("Whether this was a trainer/indoor activity"),
        commute: z.boolean().optional().describe("Whether this was a commute"),
      }),
      annotations: CREATE,
    },
    async (params) => {
      try {
        const m = mirror();
        const activity = await m.write("POST", "/activities", params, { type: "activity_detail" });
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
        "Update an activity's mutable properties. Requires activity:write scope. Only provided fields are updated (one API request); replacing values can destroy prior content. Reconcile lost responses before retrying.",
      inputSchema: z.object({
        activity_id: numericId.describe("The activity ID to update"),
        name: z.string().optional().describe("New name"),
        sport_type: z.enum(SPORT_TYPES).optional().describe("New sport type"),
        description: z.string().optional().describe("New description"),
        gear_id: z
          .union([gearId, z.literal("none")])
          .optional()
          .describe('Gear ID to associate (e.g. "b12345"), or "none" to remove'),
        trainer: z.boolean().optional().describe("Whether this is a trainer activity"),
        commute: z.boolean().optional().describe("Whether this is a commute"),
        hide_from_home: z.boolean().optional().describe("Whether to mute this activity in the feed"),
      }),
      annotations: UPDATE,
    },
    async ({ activity_id, ...updates }) => {
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
      description:
        "Page through stored comments. A cache refresh fetches the entire upstream list, potentially many API pages regardless of per_page.",
      inputSchema: z.object({
        activity_id: numericId.describe("The activity ID"),
        ...paginationSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id, page, per_page }) => {
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
      description:
        "Page through stored kudoers. A cache refresh fetches the entire upstream list, potentially many API pages regardless of per_page.",
      inputSchema: z.object({
        activity_id: numericId.describe("The activity ID"),
        ...paginationSchema,
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id, page, per_page }) => {
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
        activity_id: numericId.describe("The activity ID"),
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) => {
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
      description: "Get heart rate and power zone distribution for an activity. Shows time spent in each zone.",
      inputSchema: z.object({
        activity_id: numericId.describe("The activity ID"),
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id }) => {
      try {
        const { data, meta } = await mirror().activityZones(String(activity_id));
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
