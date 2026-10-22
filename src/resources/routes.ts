import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";

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
      const gpx = String((await mirror().routeExport(String(variables.routeId), "gpx")).data);
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
