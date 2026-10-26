import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mirror } from "../context.js";
import { schema } from "../db/inspection.js";
import { limiter } from "../strava-client.js";
import { USAGE_GUIDE } from "../usage.js";
import { resourceResult } from "./result.js";

const tableName = z.string().regex(/^[a-z_][a-z0-9_]{0,127}$/);

export function register(server: McpServer): void {
  const local = async (uri: URL, data: unknown) =>
    resourceResult(uri, { data, meta: { source: "mirror", fetched_at: null } });
  server.registerResource(
    "usage-and-limits",
    "strava://reference/usage",
    {
      title: "Strava Mirror Usage and Limits",
      description:
        "Start here: zero-call guide listing every URI template and workflow prompt with bounded examples, API costs, budgets, safe retries and coverage guidance.",
      mimeType: "text/plain",
    },
    async (uri) =>
      resourceResult(uri, { data: USAGE_GUIDE, meta: { source: "mirror", fetched_at: null } }, "text/plain"),
  );
  server.registerResource(
    "mirror-schema",
    "strava://mirror/schema",
    {
      title: "Local Mirror Schema",
      description:
        "Tables/views, units and approximate counts; local only, zero API calls. Read /schema/{table} for columns.",
      mimeType: "application/json",
    },
    async (uri) => local(uri, await schema(mirror().db)),
  );
  server.registerResource(
    "mirror-table",
    new ResourceTemplate("strava://mirror/schema/{table}", { list: undefined }),
    {
      title: "Local Table Columns",
      description: "Columns, types, units and comments for one local table/view. Zero API calls.",
      mimeType: "application/json",
    },
    async (uri, vars) => local(uri, await schema(mirror().db, tableName.parse(vars.table))),
  );
  server.registerResource(
    "mirror-status",
    "strava://mirror/status",
    {
      title: "Local Mirror Coverage and Sync",
      description:
        "Local coverage, queue, recent errors and cached rate/webhook status. Does not sync or contact Strava.",
      mimeType: "application/json",
    },
    async (uri) => local(uri, await mirror().engine.status()),
  );
  server.registerResource(
    "mirror-budget",
    "strava://mirror/budget",
    {
      title: "Cached Strava API Budget",
      description:
        "Header observations, conservative estimates, unknown pools, reserve shares and reset/cooldown times; zero API calls.",
      mimeType: "application/json",
    },
    async (uri) => local(uri, limiter.status()),
  );
}
