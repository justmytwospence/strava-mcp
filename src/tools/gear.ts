import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { mirrorResult } from "../format.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_get_gear",
    {
      title: "Get Gear",
      description:
        'Get equipment details by ID (name, brand, model, total distance). Gear IDs look like "b12345" for bikes or "g12345" for shoes.',
      inputSchema: z.object({
        gear_id: z
          .string()
          .describe('The gear ID (e.g. "b12345" for a bike, "g12345" for shoes)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ gear_id }: { gear_id: string }) => {
      try {
        const { data, meta } = await mirror().gear(gear_id);
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
