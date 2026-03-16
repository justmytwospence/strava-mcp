import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { stravaGet } from "../strava-client.js";
import type { DetailedSegment } from "../types.js";

export function register(server: McpServer): void {
  server.registerResource(
    "segment",
    new ResourceTemplate("strava://segment/{segmentId}", {
      list: undefined,
    }),
    {
      description: "Detailed Strava segment by ID.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const segment = await stravaGet<DetailedSegment>(
        `/segments/${variables.segmentId}`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(segment, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
