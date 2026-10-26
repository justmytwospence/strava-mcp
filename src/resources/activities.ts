import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { mirror } from "../context.js";
import { stringId } from "../validation.js";
import { resourceResult } from "./result.js";

export function register(server: McpServer): void {
  server.registerResource(
    "activity",
    new ResourceTemplate("strava://activity/{activityId}", { list: undefined }),
    {
      title: "Activity Detail",
      description:
        "Detailed activity with provenance. Cache-first; a missing/stale detail can cost one API request. Large bodies fail with a size notice; use SQL for bounded fields.",
      mimeType: "application/json",
    },
    async (uri, vars) => resourceResult(uri, await mirror().activity(stringId.parse(vars.activityId))),
  );
}
