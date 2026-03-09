import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import type { Stream } from "../types.js";

const ACTIVITY_STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
] as const;

const SEGMENT_STREAM_KEYS = ["latlng", "distance", "altitude"] as const;

function coerceArray<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val.split(",").map((s: string) => s.trim());
      }
    }
    return val;
  }, schema);
}

function downsample(streams: Stream[], maxPoints: number): { streams: Stream[]; downsampled: boolean } {
  if (streams.length === 0) return { streams, downsampled: false };

  const originalSize = streams[0]?.original_size ?? streams[0]?.data?.length ?? 0;
  if (originalSize <= maxPoints) return { streams, downsampled: false };

  const step = Math.ceil(originalSize / maxPoints);
  const result = streams.map((stream) => {
    const data = stream.data;
    const sampled: unknown[] = [];
    for (let i = 0; i < data.length; i += step) {
      sampled.push(data[i]);
    }
    // Always include the last point
    if (data.length > 0 && (data.length - 1) % step !== 0) {
      sampled.push(data[data.length - 1]);
    }
    return { ...stream, data: sampled, original_size: data.length };
  });

  return { streams: result, downsampled: true };
}

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_activity_streams",
    {
      title: "Get Activity Streams",
      description:
        "Get high-resolution time-series data for an activity (heart rate, power, cadence, altitude, GPS coordinates, etc.). Data is downsampled if too large.",
      inputSchema: {
        activity_id: z.coerce.number().int().describe("The activity ID"),
        keys: coerceArray(z
          .array(z.enum(ACTIVITY_STREAM_KEYS))
          .min(1))
          .describe(
            "Stream types to retrieve: time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp, moving, grade_smooth",
          ),
        max_points: z
          .coerce.number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Maximum data points to return (10-2000, default 500). Streams are downsampled if larger."),
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
      keys,
      max_points,
    }: {
      activity_id: number;
      keys: string[];
      max_points: number;
    }) => {
      try {
        const streams = await stravaGet<Stream[]>(
          `/activities/${activity_id}/streams`,
          { keys: keys.join(","), key_by_type: true },
        );
        const { streams: result, downsampled } = downsample(streams, max_points);
        return jsonResult({
          streams: result,
          _meta: {
            total_points: streams[0]?.original_size ?? streams[0]?.data?.length ?? 0,
            returned_points: result[0]?.data?.length ?? 0,
            downsampled,
          },
        });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_segment_effort_streams",
    {
      title: "Get Segment Effort Streams",
      description:
        "Get high-resolution time-series data for a segment effort.",
      inputSchema: {
        effort_id: z.string().describe("The segment effort ID"),
        keys: coerceArray(z
          .array(z.enum(ACTIVITY_STREAM_KEYS))
          .min(1))
          .describe("Stream types to retrieve"),
        max_points: z
          .coerce.number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Maximum data points (10-2000, default 500)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      effort_id,
      keys,
      max_points,
    }: {
      effort_id: string;
      keys: string[];
      max_points: number;
    }) => {
      try {
        const streams = await stravaGet<Stream[]>(
          `/segment_efforts/${effort_id}/streams`,
          { keys: keys.join(","), key_by_type: true },
        );
        const { streams: result, downsampled } = downsample(streams, max_points);
        return jsonResult({
          streams: result,
          _meta: {
            total_points: streams[0]?.original_size ?? streams[0]?.data?.length ?? 0,
            returned_points: result[0]?.data?.length ?? 0,
            downsampled,
          },
        });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_segment_streams",
    {
      title: "Get Segment Streams",
      description:
        "Get GPS coordinates, distance, and altitude data for a segment.",
      inputSchema: {
        segment_id: z.coerce.number().int().describe("The segment ID"),
        keys: coerceArray(z
          .array(z.enum(SEGMENT_STREAM_KEYS))
          .min(1))
          .describe("Stream types: latlng, distance, altitude"),
        max_points: z
          .coerce.number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Maximum data points (10-2000, default 500)"),
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
      keys,
      max_points,
    }: {
      segment_id: number;
      keys: string[];
      max_points: number;
    }) => {
      try {
        const streams = await stravaGet<Stream[]>(
          `/segments/${segment_id}/streams`,
          { keys: keys.join(","), key_by_type: true },
        );
        const { streams: result, downsampled } = downsample(streams, max_points);
        return jsonResult({
          streams: result,
          _meta: {
            total_points: streams[0]?.original_size ?? streams[0]?.data?.length ?? 0,
            returned_points: result[0]?.data?.length ?? 0,
            downsampled,
          },
        });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_route_streams",
    {
      title: "Get Route Streams",
      description:
        "Get GPS coordinates, distance, and altitude data for a route.",
      inputSchema: {
        route_id: z.string().describe("The route ID"),
        max_points: z
          .coerce.number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Maximum data points (10-2000, default 500)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      route_id,
      max_points,
    }: {
      route_id: string;
      max_points: number;
    }) => {
      try {
        const streams = await stravaGet<Stream[]>(
          `/routes/${route_id}/streams`,
        );
        const { streams: result, downsampled } = downsample(streams, max_points);
        return jsonResult({
          streams: result,
          _meta: {
            total_points: streams[0]?.original_size ?? streams[0]?.data?.length ?? 0,
            returned_points: result[0]?.data?.length ?? 0,
            downsampled,
          },
        });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
