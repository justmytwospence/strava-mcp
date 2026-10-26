import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";
import { stringId } from "../validation.js";
import { resourceResult } from "./result.js";

export function register(server: McpServer): void {
  server.registerResource(
    "segment",
    new ResourceTemplate("strava://segment/{segmentId}", { list: undefined }),
    {
      title: "Segment Detail",
      description: "Detailed segment with provenance. Cache-first; a refresh costs one API request.",
      mimeType: "application/json",
    },
    async (uri, vars) => resourceResult(uri, await mirror().segment(stringId.parse(vars.segmentId))),
  );
}
