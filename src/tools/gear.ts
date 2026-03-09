import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult } from "../format.js";
import type { SummaryGear } from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_gear",
    {
      title: "Get Gear",
      description:
        'Get equipment details by ID (name, brand, model, total distance). Gear IDs look like "b12345" for bikes or "g12345" for shoes.',
      inputSchema: {
        gear_id: z
          .string()
          .describe('The gear ID (e.g. "b12345" for a bike, "g12345" for shoes)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ gear_id }: { gear_id: string }) => {
      try {
        const gear = await stravaGet<SummaryGear>(`/gear/${gear_id}`);
        return jsonResult(gear);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
