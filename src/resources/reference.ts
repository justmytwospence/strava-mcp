import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACTIVITY_STREAM_KEYS,
  SEGMENT_STREAM_KEYS,
  SPORT_TYPES,
  STREAM_TYPE_DESCRIPTIONS,
} from "../constants.js";

export function register(server: McpServer): void {
  server.registerResource(
    "sport-types",
    "strava://reference/sport-types",
    {
      description:
        "Valid Strava sport_type values for create/update activity and for interpreting activity data.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({ sport_types: SPORT_TYPES }, null, 2),
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.registerResource(
    "stream-types",
    "strava://reference/stream-types",
    {
      description:
        "Available stream types for the stream tools. Pass one or more keys as the keys parameter.",
      mimeType: "application/json",
    },
    async (uri) => {
      const segmentKeys = new Set<string>(SEGMENT_STREAM_KEYS);
      const streams = ACTIVITY_STREAM_KEYS.map((key) => ({
        key,
        description: STREAM_TYPE_DESCRIPTIONS[key],
        valid_for: segmentKeys.has(key)
          ? ["activity", "segment", "segment_effort", "route"]
          : ["activity"],
      }));
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ streams }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
