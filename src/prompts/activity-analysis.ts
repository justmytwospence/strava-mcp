import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import {
  formatDistance,
  formatDuration,
  formatPace,
  formatDate,
} from "../format.js";
import type { DetailedActivity, Stream } from "../types.js";

function formatSplit(s: { split: number; distance: number; moving_time: number; average_speed: number; elevation_difference: number; average_heartrate?: number }): string {
  const parts = [
    `  Split ${s.split}: ${formatDistance(s.distance)} in ${formatDuration(s.moving_time)}`,
    `    Pace: ${formatPace(s.average_speed)} | Elev: ${s.elevation_difference > 0 ? "+" : ""}${Math.round(s.elevation_difference)}m`,
  ];
  if (s.average_heartrate) parts.push(`    Avg HR: ${s.average_heartrate} bpm`);
  return parts.join("\n");
}

export function register(server: McpServer): void {
  server.registerPrompt(
    "activity-analysis",
    {
      title: "Activity Deep Analysis",
      description:
        "Fetch a Strava activity with streams and request a detailed analysis of pacing, effort, and performance.",
      argsSchema: {
        activity_id: z.string().describe("The Strava activity ID to analyze"),
      },
    },
    async ({ activity_id }) => {
      const activity = await stravaGet<DetailedActivity>(
        `/activities/${activity_id}`,
        { include_all_efforts: true },
      );

      let streamsText = "";
      try {
        const streams = await stravaGet<Stream[]>(
          `/activities/${activity_id}/streams`,
          {
            keys: "time,distance,heartrate,altitude,velocity_smooth,cadence,watts",
            key_by_type: true,
          },
        );
        const streamSummaries = streams.map((s) => {
          const data = s.data as number[];
          const min = Math.min(...data);
          const max = Math.max(...data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          return `  ${s.type}: min=${min.toFixed(1)}, max=${max.toFixed(1)}, avg=${avg.toFixed(1)} (${data.length} points)`;
        });
        streamsText = "\nStream summaries:\n" + streamSummaries.join("\n");
      } catch {
        streamsText = "\n(Stream data not available for this activity)";
      }

      const header = [
        `Activity: ${activity.name} (${activity.sport_type})`,
        `Date: ${formatDate(activity.start_date_local)}`,
        `Distance: ${formatDistance(activity.distance)}`,
        `Duration: ${formatDuration(activity.moving_time)} moving / ${formatDuration(activity.elapsed_time)} elapsed`,
        `Elevation: +${Math.round(activity.total_elevation_gain)}m`,
        `Calories: ${activity.calories}`,
      ];
      if (activity.average_heartrate) header.push(`Avg HR: ${activity.average_heartrate} bpm | Max HR: ${activity.max_heartrate} bpm`);
      if (activity.average_watts) header.push(`Avg Power: ${activity.average_watts}W | Max Power: ${activity.max_watts}W`);
      if (activity.average_cadence) header.push(`Avg Cadence: ${activity.average_cadence}`);
      if (activity.device_name) header.push(`Device: ${activity.device_name}`);
      if (activity.gear) header.push(`Gear: ${activity.gear.name}`);

      const splits = activity.splits_metric?.length
        ? "\nKilometer splits:\n" + activity.splits_metric.map(formatSplit).join("\n")
        : "";

      const efforts = activity.segment_efforts?.length
        ? `\nSegment efforts: ${activity.segment_efforts.length} segments hit`
        : "";

      const text = [
        header.join("\n"),
        splits,
        streamsText,
        efforts,
        "",
        "Please provide a detailed analysis of this activity. Cover pacing strategy, effort distribution, heart rate zones (if available), and any notable patterns in the splits or streams. Offer suggestions for improvement.",
      ].join("\n");

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );
}
