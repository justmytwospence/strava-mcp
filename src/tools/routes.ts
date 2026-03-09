import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import { formatToolError } from "../errors.js";
import { jsonResult, textResult } from "../format.js";
import { paginationSchema, formatPaginationNote } from "../pagination.js";
import type { Route } from "../types.js";

export function register(server: McpServer): void {
  server.registerTool(
    "strava_list_athlete_routes",
    {
      title: "List Athlete Routes",
      description: "List routes created by an athlete.",
      inputSchema: {
        athlete_id: z.coerce.number().int().describe("The athlete ID"),
        ...paginationSchema,
      },
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
        const routes = await stravaGet<Route[]>(
          `/athletes/${athlete_id}/routes`,
          { page, per_page },
        );
        const note = formatPaginationNote(routes.length, page, per_page);
        return jsonResult({ routes, _pagination: note });
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
      inputSchema: {
        route_id: z.string().describe("The route ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route_id }: { route_id: string }) => {
      try {
        const route = await stravaGet<Route>(`/routes/${route_id}`);
        return jsonResult(route);
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
      inputSchema: {
        route_id: z.string().describe("The route ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route_id }: { route_id: string }) => {
      try {
        const gpx = await stravaGet<string>(`/routes/${route_id}/export_gpx`);
        return textResult(gpx);
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
      inputSchema: {
        route_id: z.string().describe("The route ID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ route_id }: { route_id: string }) => {
      try {
        const tcx = await stravaGet<string>(`/routes/${route_id}/export_tcx`);
        return textResult(tcx);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
