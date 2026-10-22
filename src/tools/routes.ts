import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { formatToolError } from "../errors.js";
import { mirrorResult, pageOf, textResult } from "../format.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_athlete_routes",
    {
      title: "List Athlete Routes",
      description: "List routes created by an athlete.",
      inputSchema: z.object({
        athlete_id: z.coerce.number().int().describe("The athlete ID"),
        ...paginationSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      athlete_id,
      page,
      per_page,
    }: {
      athlete_id: number;
      page: number;
      per_page: number;
    }) => {
      try {
        // Only the authenticated athlete's routes are mirrored (Strava serves no others).
        void athlete_id;
        const { data, meta } = await mirror().routes();
        const routes = pageOf(data as unknown[], page, per_page);
        const note = formatPaginationNote(routes.length, page, per_page);
        return mirrorResult({ routes, _pagination: note }, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_get_route",
    {
      title: "Get Route",
      description:
        "Get detailed route information including distance, elevation gain, and estimated moving time.",
      inputSchema: z.object({
        route_id: z.string().describe("The route ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route_id }: { route_id: string }) => {
      try {
        const { data, meta } = await mirror().route(route_id);
        return mirrorResult(data, meta);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_export_route_gpx",
    {
      title: "Export Route as GPX",
      description:
        "Export a route as a GPX file. Returns raw GPX XML content.",
      inputSchema: z.object({
        route_id: z.string().describe("The route ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route_id }: { route_id: string }) => {
      try {
        const { data } = await mirror().routeExport(route_id, "gpx");
        return textResult(String(data));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    "strava_export_route_tcx",
    {
      title: "Export Route as TCX",
      description:
        "Export a route as a TCX file. Returns raw TCX XML content.",
      inputSchema: z.object({
        route_id: z.string().describe("The route ID"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route_id }: { route_id: string }) => {
      try {
        const { data } = await mirror().routeExport(route_id, "tcx");
        return textResult(String(data));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
