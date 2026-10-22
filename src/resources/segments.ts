import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";
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
      const segment = (await mirror().segment(String(variables.segmentId))).data as DetailedSegment;
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
