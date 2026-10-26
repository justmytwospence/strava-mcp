import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ACTIVITY_STREAM_KEYS, SEGMENT_STREAM_KEYS } from "../constants.js";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { mirrorResult } from "../format.js";
import { numericId, stringId } from "../validation.js";
import { READ_ONLY } from "./annotations.js";

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

const maxPoints = z.coerce
  .number()
  .int()
  .min(10)
  .max(2000)
  .default(500)
  .describe("Maximum data points to return (10-2000, default 500). Streams are downsampled if larger.");

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
  // Reserve a slot for the final point; the old stride plus endpoint could return maxPoints + 1.
  const step = Math.ceil((total - 1) / (maxPoints - 1));
  const thinned: StreamSet = {};
  for (const [k, s] of Object.entries(wanted)) {
    const data: unknown[] = [];
    for (let i = 0; i < s.data.length; i += step) data.push(s.data[i]);
    if (s.data.length === total && (total - 1) % step !== 0) data.push(s.data[total - 1]);
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
        "Get high-resolution time-series data for an activity (heart rate, power, cadence, altitude, GPS coordinates, etc.). Data is downsampled if too large. Cache miss normally costs one API request. Missing stream rate headers mean unknown accounting, not free calls; check strava_sync_status or strava://mirror/budget first.",
      inputSchema: z.object({
        activity_id: numericId.describe("The activity ID"),
        keys: coerceArray(z.array(z.enum(ACTIVITY_STREAM_KEYS)).min(1).max(ACTIVITY_STREAM_KEYS.length)).describe(
          "Stream types to retrieve: time, distance, latlng, altitude, velocity_smooth, heartrate, cadence, watts, temp, moving, grade_smooth",
        ),
        max_points: maxPoints,
      }),
      annotations: READ_ONLY,
    },
    async ({ activity_id, keys, max_points }) => {
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
        "Get bounded/downsampled time-series data for a segment effort. Cache miss normally costs one API request; check strava_sync_status or strava://mirror/budget. Missing headers do not exempt requests from known quotas.",
      inputSchema: z.object({
        effort_id: stringId.describe("The segment effort ID"),
        keys: coerceArray(z.array(z.enum(ACTIVITY_STREAM_KEYS)).min(1).max(ACTIVITY_STREAM_KEYS.length)).describe(
          "Stream types to retrieve",
        ),
        max_points: maxPoints,
      }),
      annotations: READ_ONLY,
    },
    async ({ effort_id, keys, max_points }) => {
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
        "Get bounded/downsampled GPS, distance and altitude data for a segment. Cache miss normally costs one API request; check strava_sync_status or strava://mirror/budget first.",
      inputSchema: z.object({
        segment_id: numericId.describe("The segment ID"),
        keys: coerceArray(z.array(z.enum(SEGMENT_STREAM_KEYS)).min(1).max(SEGMENT_STREAM_KEYS.length)).describe(
          "Stream types: latlng, distance, altitude",
        ),
        max_points: maxPoints,
      }),
      annotations: READ_ONLY,
    },
    async ({ segment_id, keys, max_points }) => {
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
        "Get bounded/downsampled GPS, distance and altitude data for a route. A cache refresh normally costs one API request; check strava_sync_status or strava://mirror/budget first.",
      inputSchema: z.object({
        route_id: stringId.describe("The route ID"),
        max_points: maxPoints,
      }),
      annotations: READ_ONLY,
    },
    async ({ route_id, max_points }) => {
      try {
        const { data, meta } = await mirror().routeStreams(route_id);
        return mirrorResult(selectStreams(data, null, max_points), meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
