import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDate, formatDistance, formatDuration, formatElevation } from "../format.js";
import type { SummaryActivity } from "../types.js";
import { lookbackDays } from "../validation.js";
import { contextNote, localContext, promptText } from "./context.js";

export function register(server: McpServer): void {
  server.registerPrompt(
    "training-plan-review",
    {
      title: "Training Plan Review",
      description:
        "Review 1-365 days of stored training (at most 200 activities) with coverage/provenance. Local only, zero API calls; refresh with tools separately.",
      argsSchema: z.object({
        days: lookbackDays.optional().describe("Integer days to look back, 1-365 (default 30)"),
      }),
    },
    async ({ days }) => {
      const numDays = days ? Number(days) : 30;
      const after = Math.floor(Date.now() / 1000) - numDays * 86400;

      const result = await localContext().listActivities({ after, page: 1, perPage: 200 });
      const activities = result.data as SummaryActivity[];

      if (activities.length === 0) {
        return promptText(
          `${contextNote(result)}\nNo stored activities found in the last ${numDays} days. Check coverage before inferring no training.`,
        );
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
        const header = `${type}: ${acts.length} activities | ${formatDistance(totalDist)} | ${formatDuration(totalTime)} | ${formatElevation(totalElev)} gain`;
        const list = acts
          .map(
            (a) =>
              `  - ${formatDate(a.start_date_local)}: ${a.name} | ${formatDistance(a.distance)} | ${formatDuration(a.moving_time)}`,
          )
          .join("\n");
        return `${header}\n${list}`;
      });

      const text = [
        `Training log for the last ${numDays} days (${activities.length} activities):`,
        "",
        ...sections,
        "",
        "Please review my training load. Analyze volume progression, recovery patterns, sport balance, and overtraining risk. Suggest adjustments to optimize performance and reduce injury risk.",
      ].join("\n");

      return promptText(`${contextNote(result)}\n\n${text}`);
    },
  );
}
