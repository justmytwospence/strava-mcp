import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";
import { stringId } from "../validation.js";
import { resourceResult } from "./result.js";

export function register(server: McpServer): void {
  server.registerResource(
    "route-gpx",
    new ResourceTemplate("strava://route/{routeId}/gpx", { list: undefined }),
    {
      title: "Route GPX",
      description:
        "Route GPX body plus separate provenance. Cache-first; refresh costs one API request. No file is written. Oversized content is rejected, not silently truncated.",
      mimeType: "application/gpx+xml",
    },
    async (uri, vars) =>
      resourceResult(uri, await mirror().routeExport(stringId.parse(vars.routeId), "gpx"), "application/gpx+xml"),
  );
}
