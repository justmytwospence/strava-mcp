import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { stravaGet } from "../strava-client.js";
import type { DetailedActivity } from "../types.js";

export function register(server: McpServer): void {
  server.registerResource(
    "activity",
    new ResourceTemplate("strava://activity/{activityId}", {
      list: undefined,
    }),
    {
      description: "Detailed Strava activity by ID.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const activity = await stravaGet<DetailedActivity>(
        `/activities/${variables.activityId}`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(activity, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
