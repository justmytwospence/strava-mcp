import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import {
  formatDistance,
  formatDuration,
  formatDate,
} from "../format.js";
import type { SummaryActivity } from "../types.js";

function getMondayBefore(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function formatActivity(a: SummaryActivity): string {
  const parts = [
    `- ${a.name} (${a.sport_type})`,
    `  ${formatDate(a.start_date_local)}`,
    `  ${formatDistance(a.distance)} | ${formatDuration(a.moving_time)} | ${Math.round(a.total_elevation_gain)}m gain`,
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
        "Summarize training for a given week based on Strava activities.",
      argsSchema: {
        week_start: z
          .string()
          .optional()
          .describe(
            "ISO 8601 date for the start of the week (defaults to last Monday)",
          ),
      },
    },
    async ({ week_start }) => {
      const start = week_start
        ? new Date(week_start)
        : getMondayBefore(new Date());
      const end = new Date(start);
      end.setDate(end.getDate() + 7);

      const after = Math.floor(start.getTime() / 1000);
      const before = Math.floor(end.getTime() / 1000);

      const activities = await stravaGet<SummaryActivity[]>(
        "/athlete/activities",
        { after, before, per_page: 200 },
      );

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

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );
}
