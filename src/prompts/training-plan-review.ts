import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import {
  formatDistance,
  formatDuration,
  formatDate,
} from "../format.js";
import type { SummaryActivity } from "../types.js";

export function register(server: McpServer): void {
  server.registerPrompt(
    "training-plan-review",
    {
      title: "Training Plan Review",
      description:
        "Review recent training load and suggest adjustments based on activity history.",
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe("Number of days to look back (default 30)"),
      },
    },
    async ({ days }) => {
      const numDays = days ? parseInt(days, 10) : 30;
      const after = Math.floor(Date.now() / 1000) - numDays * 86400;

      const activities = await stravaGet<SummaryActivity[]>(
        "/athlete/activities",
        { after, per_page: 200 },
      );

      if (activities.length === 0) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `No activities found in the last ${numDays} days. Please suggest how to get started with a training plan.`,
              },
            },
          ],
        };
      }

      const byType: Record<string, SummaryActivity[]> = {};
      for (const a of activities) {
        const t = a.sport_type;
        if (!byType[t]) byType[t] = [];
        byType[t].push(a);
      }

      const sections = Object.entries(byType).map(([type, acts]) => {
        const totalDist = acts.reduce((s, a) => s + a.distance, 0);
        const totalTime = acts.reduce((s, a) => s + a.moving_time, 0);
        const totalElev = acts.reduce((s, a) => s + a.total_elevation_gain, 0);
        const header = `${type}: ${acts.length} activities | ${formatDistance(totalDist)} | ${formatDuration(totalTime)} | ${Math.round(totalElev)}m gain`;
        const list = acts
          .map(
            (a) =>
              `  - ${formatDate(a.start_date_local)}: ${a.name} | ${formatDistance(a.distance)} | ${formatDuration(a.moving_time)}`,
          )
          .join("\n");
        return header + "\n" + list;
      });

      const text = [
        `Training log for the last ${numDays} days (${activities.length} activities):`,
        "",
        ...sections,
        "",
        "Please review my training load. Analyze volume progression, recovery patterns, sport balance, and overtraining risk. Suggest adjustments to optimize performance and reduce injury risk.",
      ].join("\n");

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );
}
