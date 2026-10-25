import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import polyline from "@mapbox/polyline";
import { buildGPX, BaseBuilder } from "gpx-builder";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { formatDistance, formatElevation, jsonResult, mirrorResult, textResult } from "../format.js";
import type { DetailedSegment } from "../types.js";

const { Point, Segment, Track } = BaseBuilder.MODELS;

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_segment",
    {
      title: "Get Segment",
      description:
        "Get detailed information about a segment including distance, elevation, grade, effort count, and athlete count.",
      inputSchema: z.object({
        segment_id: z.coerce.number().int().describe("The segment ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ segment_id }: { segment_id: number }) => {
      try {
        const { data, meta } = await mirror().segment(String(segment_id));
        return mirrorResult(data, meta);
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
        "List the authenticated athlete's efforts on a segment, newest first, optionally filtered by date range. Served from the mirror once every activity's efforts are synced.",
      inputSchema: z.object({
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
      }),
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
        const { data: efforts, meta } = await mirror().segmentEfforts(
          String(segment_id),
          { start: start_date_local, end: end_date_local },
          per_page,
        );
        return mirrorResult({ efforts, count: efforts.length }, meta);
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
      inputSchema: z.object({
        effort_id: z.string().describe("The segment effort ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ effort_id }: { effort_id: string }) => {
      try {
        const { data, meta } = await mirror().segmentEffort(effort_id);
        return mirrorResult(data, meta);
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
      inputSchema: z.object({
        segment_id: z.coerce.number().int().describe("The segment ID"),
        starred: z.boolean().describe("True to star, false to unstar"),
      }),
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
        const m = mirror();
        const segment = await m.write("PUT", `/segments/${segment_id}/starred`, { starred }, { type: "segment" });
        await m.engine.enqueue("starred_segments", "self", 5);
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
      inputSchema: z.object({
        segment_id: z.coerce.number().int().describe("The segment ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ segment_id }: { segment_id: number }) => {
      try {
        const segment = (await mirror().segment(String(segment_id))).data as DetailedSegment;

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
          `${formatElevation(segment.total_elevation_gain)} gain`,
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
