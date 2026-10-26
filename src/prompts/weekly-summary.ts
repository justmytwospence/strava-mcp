import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDate, formatDistance, formatDuration, formatElevation } from "../format.js";
import type { SummaryActivity } from "../types.js";
import { isoDate } from "../validation.js";
import { contextNote, localContext, promptText } from "./context.js";

function getMondayBefore(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function formatActivity(a: SummaryActivity): string {
  const parts = [
    `- ${a.name} (${a.sport_type})`,
    `  ${formatDate(a.start_date_local)}`,
    `  ${formatDistance(a.distance)} | ${formatDuration(a.moving_time)} | ${formatElevation(a.total_elevation_gain)} gain`,
  ];
  if (a.average_heartrate) parts.push(`  Avg HR: ${a.average_heartrate} bpm`);
  if (a.average_watts) parts.push(`  Avg Power: ${a.average_watts}W`);
  return parts.join("\n");
}

export function register(server: McpServer): void {
  server.registerPrompt(
    "weekly-summary",
    {
      title: "Weekly Training Summary",
      description:
        "Summarize a UTC week from at most 200 stored activities, with coverage/provenance. Local only, zero API calls; refresh via tools separately if needed.",
      argsSchema: z.object({
        week_start: isoDate
          .optional()
          .describe("YYYY-MM-DD start of a seven-day UTC window (defaults to this Monday UTC)"),
      }),
    },
    async ({ week_start }) => {
      const start = week_start ? new Date(week_start) : getMondayBefore(new Date());
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);

      const after = Math.floor(start.getTime() / 1000);
      const before = Math.floor(end.getTime() / 1000);

      const result = await localContext().listActivities({ after, before, page: 1, perPage: 200 });
      const activities = result.data as SummaryActivity[];

      const startStr = start.toISOString().split("T")[0];
      const endStr = end.toISOString().split("T")[0];

      let text: string;
      if (activities.length === 0) {
        text = `No activities found for the week of ${startStr} to ${endStr}.`;
      } else {
        const list = activities.map(formatActivity).join("\n\n");
        text = [
          `Here are my ${activities.length} Strava activities from ${startStr} to ${endStr}:`,
          "",
          list,
          "",
          "Please provide a training summary for this week. Include total volume by sport, intensity observations, and any patterns or recommendations.",
        ].join("\n");
      }

      return promptText(`${contextNote(result)}\n\n${text}`);
    },
  );
}
