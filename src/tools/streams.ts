import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { mirrorResult } from "../format.js";
import { ACTIVITY_STREAM_KEYS, SEGMENT_STREAM_KEYS } from "../constants.js";

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

type StreamSet = Record<string, { data: unknown[]; original_size?: number; resolution?: string; series_type?: string }>;

/**
 * Normalize either stream shape (keyed by type, or an array of {type, data}) to an
 * object keyed by type, keep the requested keys, and thin every stream with the same
 * stride so the points stay aligned.
 */
function selectStreams(raw: unknown, keys: string[] | null, maxPoints: number) {
  const set: StreamSet = {};
  if (Array.isArray(raw)) {
    for (const s of raw as Array<{ type: string; data: unknown[] }>) set[s.type] = s;
  } else if (raw && typeof raw === "object") {
    Object.assign(set, raw);
  }
  const wanted = keys ? Object.fromEntries(Object.entries(set).filter(([k]) => keys.includes(k))) : set;
  const total = Math.max(0, ...Object.values(wanted).map((s) => s.data?.length ?? 0));
  if (total <= maxPoints) {
    return { streams: wanted, _meta: { total_points: total, returned_points: total, downsampled: false } };
  }
  const step = Math.ceil(total / maxPoints);
  const thinned: StreamSet = {};
  for (const [k, s] of Object.entries(wanted)) {
    const data: unknown[] = [];
    for (let i = 0; i < s.data.length; i += step) data.push(s.data[i]);
    if (s.data.length > 0 && (s.data.length - 1) % step !== 0) data.push(s.data[s.data.length - 1]);
    thinned[k] = { ...s, data, original_size: s.data.length };
  }
  const returned = Math.max(0, ...Object.values(thinned).map((s) => s.data.length));
  return { streams: thinned, _meta: { total_points: total, returned_points: returned, downsampled: true, step } };
}

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_activity_streams",
    {
      title: "Get Activity Streams",
      description:
        "Get high-resolution time-series data for an activity (heart rate, power, cadence, altitude, GPS coordinates, etc.). Data is downsampled if too large.",
      inputSchema: z.object({
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
      keys,
      max_points,
    }: {
      activity_id: number;
      keys: string[];
      max_points: number;
    }) => {
      try {
        const { data, meta } = await mirror().activityStreams(String(activity_id));
        return mirrorResult(selectStreams(data, keys, max_points), meta);
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
      inputSchema: z.object({
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
      }),
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
        const { data, meta } = await mirror().segmentEffortStreams(effort_id);
        return mirrorResult(selectStreams(data, keys, max_points), meta);
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
      inputSchema: z.object({
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
      keys,
      max_points,
    }: {
      segment_id: number;
      keys: string[];
      max_points: number;
    }) => {
      try {
        const { data, meta } = await mirror().segmentStreams(String(segment_id));
        return mirrorResult(selectStreams(data, keys, max_points), meta);
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
      inputSchema: z.object({
        route_id: z.string().describe("The route ID"),
        max_points: z
          .coerce.number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe("Maximum data points (10-2000, default 500)"),
      }),
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
        const { data, meta } = await mirror().routeStreams(route_id);
        return mirrorResult(selectStreams(data, null, max_points), meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
