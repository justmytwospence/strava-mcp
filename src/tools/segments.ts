import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import polyline from "@mapbox/polyline";
import { buildGPX, BaseBuilder } from "gpx-builder";
import { stravaGet, stravaPut } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult, textResult, formatDistance } from "../format.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";
import type {
  DetailedSegment,
  SegmentEffort,
  ExplorerSegment,
} from "../types.js";

const { Point, Segment, Track } = BaseBuilder.MODELS;

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_segment",
    {
      title: "Get Segment",
      description:
        "Get detailed information about a segment including distance, elevation, grade, effort count, and athlete count.",
      inputSchema: {
        segment_id: z.coerce.number().int().describe("The segment ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ segment_id }: { segment_id: number }) => {
      try {
        const segment = await stravaGet<DetailedSegment>(
          `/segments/${segment_id}`,
        );
        return jsonResult(segment);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_list_segment_efforts",
    {
      title: "List Segment Efforts",
      description:
        "List efforts on a segment, optionally filtered by date range. Returns the authenticated athlete's efforts by default.",
      inputSchema: {
        segment_id: z.coerce.number().int().describe("The segment ID"),
        start_date_local: z
          .string()
          .optional()
          .describe("Filter efforts after this ISO 8601 date"),
        end_date_local: z
          .string()
          .optional()
          .describe("Filter efforts before this ISO 8601 date"),
        per_page: z
          .coerce.number()
          .int()
          .min(1)
          .max(200)
          .default(30)
          .describe("Results per page (1-200, default 30)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      segment_id,
      start_date_local,
      end_date_local,
      per_page,
    }: {
      segment_id: number;
      start_date_local?: string;
      end_date_local?: string;
      per_page: number;
    }) => {
      try {
        const efforts = await stravaGet<SegmentEffort[]>(
          "/segment_efforts",
          {
            segment_id,
            start_date_local,
            end_date_local,
            per_page,
          },
        );
        return jsonResult({ efforts, count: efforts.length });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_segment_effort",
    {
      title: "Get Segment Effort",
      description:
        "Get a specific segment effort by ID, including elapsed time, heart rate, watts, and achievements.",
      inputSchema: {
        effort_id: z.string().describe("The segment effort ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ effort_id }: { effort_id: string }) => {
      try {
        const effort = await stravaGet<SegmentEffort>(
          `/segment_efforts/${effort_id}`,
        );
        return jsonResult(effort);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_explore_segments",
    {
      title: "Explore Segments",
      description:
        'Find popular segments within a geographic bounding box. Provide SW and NE corner coordinates as a comma-separated string: "sw_lat,sw_lng,ne_lat,ne_lng".',
      inputSchema: {
        bounds: z
          .string()
          .describe(
            'Bounding box: "south_lat,west_lng,north_lat,east_lng" (e.g. "37.7,-122.5,37.8,-122.4")',
          ),
        activity_type: z
          .enum(["running", "riding"])
          .optional()
          .describe('Filter by activity type: "running" or "riding"'),
        min_cat: z
          .coerce.number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Minimum climb category (0-5, where 0 is NC and 5 is HC)"),
        max_cat: z
          .coerce.number()
          .int()
          .min(0)
          .max(5)
          .optional()
          .describe("Maximum climb category (0-5)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      bounds,
      activity_type,
      min_cat,
      max_cat,
    }: {
      bounds: string;
      activity_type?: string;
      min_cat?: number;
      max_cat?: number;
    }) => {
      try {
        const result = await stravaGet<{ segments: ExplorerSegment[] }>(
          "/segments/explore",
          { bounds, activity_type, min_cat, max_cat },
        );
        return jsonResult(result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_star_segment",
    {
      title: "Star/Unstar Segment",
      description: "Star or unstar a segment for the authenticated athlete.",
      inputSchema: {
        segment_id: z.coerce.number().int().describe("The segment ID"),
        starred: z.boolean().describe("True to star, false to unstar"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      segment_id,
      starred,
    }: {
      segment_id: number;
      starred: boolean;
    }) => {
      try {
        const segment = await stravaPut<DetailedSegment>(
          `/segments/${segment_id}/starred`,
          { starred },
        );
        return jsonResult(segment);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_export_segment_gpx",
    {
      title: "Export Segment as GPX",
      description:
        "Export a Strava segment as a GPX file for navigation. Returns GPX XML that can be imported into Garmin Connect, Coros, or other GPS devices. Note: The Strava API does not support uploading routes, so the GPX must be imported manually into your device/app.",
      inputSchema: {
        segment_id: z.coerce.number().int().describe("The segment ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ segment_id }: { segment_id: number }) => {
      try {
        const segment = await stravaGet<DetailedSegment>(
          `/segments/${segment_id}`,
        );

        const encoded =
          segment.map.polyline ?? segment.map.summary_polyline;
        if (!encoded) {
          return textResult("No polyline data available for this segment.");
        }

        const coords = polyline.decode(encoded);
        const points = coords.map(
          ([lat, lon]: [number, number]) => new Point(lat, lon),
        );

        const desc = [
          formatDistance(segment.distance),
          `${Math.round(segment.total_elevation_gain)}m gain`,
          `${segment.average_grade}% avg grade`,
        ].join(" | ");

        const gpxData = new BaseBuilder();
        gpxData.setTracks([
          new Track(
            [new Segment(points)],
            { name: segment.name, desc },
          ),
        ]);

        return textResult(buildGPX(gpxData.toObject()));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
