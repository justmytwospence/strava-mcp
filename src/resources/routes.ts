import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { stravaGet } from "../strava-client.js";

export function register(server: McpServer): void {
  server.registerResource(
    "route-gpx",
    new ResourceTemplate("strava://route/{routeId}/gpx", {
      list: undefined,
    }),
    {
      description: "Export a Strava route as GPX.",
      mimeType: "application/gpx+xml",
    },
    async (uri, variables) => {
      const gpx = await stravaGet<string>(
        `/routes/${variables.routeId}/export_gpx`,
      );
      return {
        contents: [
          {
            uri: uri.href,
            text: gpx,
            mimeType: "application/gpx+xml",
          },
        ],
      };
    },
  );
}
