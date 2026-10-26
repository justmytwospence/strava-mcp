import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDate, formatDistance, formatDuration, formatElevation, formatPace, getDefaultUnits } from "../format.js";
import type { DetailedActivity, Stream } from "../types.js";
import { stringId } from "../validation.js";
import { contextNote, localContext, promptText } from "./context.js";

function formatSplit(s: {
  split: number;
  distance: number;
  moving_time: number;
  average_speed: number;
  elevation_difference: number;
  average_heartrate?: number;
}): string {
  const parts = [
    `  Split ${s.split}: ${formatDistance(s.distance)} in ${formatDuration(s.moving_time)}`,
    `    Pace: ${formatPace(s.average_speed)} | Elev: ${formatElevation(s.elevation_difference, undefined, true)}`,
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
        "Analyze a stored activity and stream summaries with provenance. Local only, zero API calls; missing streams are disclosed. Refresh via tools separately.",
      argsSchema: z.object({
        activity_id: stringId.describe("The Strava activity ID to analyze"),
      }),
    },
    async ({ activity_id }) => {
      const m = localContext();
      const activityResult = await m.activity(activity_id);
      const activity = activityResult.data as DetailedActivity;
      let provenance = contextNote(activityResult);
      let streamsText = "";
      try {
        const wanted = ["time", "distance", "heartrate", "altitude", "velocity_smooth", "cadence", "watts"];
        const streamsResult = await m.activityStreams(activity_id);
        provenance += `\n${contextNote(streamsResult)}`;
        const all = streamsResult.data as Record<string, Stream>;
        const streamSummaries = wanted
          .filter((k) => Array.isArray(all[k]?.data) && all[k]!.data.length > 0)
          .map((k) => {
            const data = all[k]!.data as number[];
            let min = Number.POSITIVE_INFINITY;
            let max = Number.NEGATIVE_INFINITY;
            let sum = 0;
            for (const v of data) {
              if (v < min) min = v;
              if (v > max) max = v;
              sum += v;
            }
            const avg = sum / data.length;
            return `  ${k}: min=${min.toFixed(1)}, max=${max.toFixed(1)}, avg=${avg.toFixed(1)} (${data.length} points)`;
          });
        streamsText = `\nStream summaries:\n${streamSummaries.join("\n")}`;
      } catch {
        streamsText =
          "\n(Partial context: no stored stream data available; stream-dependent conclusions are unsupported.)";
      }

      const header = [
        `Activity: ${activity.name} (${activity.sport_type})`,
        `Date: ${formatDate(activity.start_date_local)}`,
        `Distance: ${formatDistance(activity.distance)}`,
        `Duration: ${formatDuration(activity.moving_time)} moving / ${formatDuration(activity.elapsed_time)} elapsed`,
        `Elevation: ${formatElevation(activity.total_elevation_gain, undefined, true)}`,
        `Calories: ${activity.calories}`,
      ];
      if (activity.average_heartrate)
        header.push(`Avg HR: ${activity.average_heartrate} bpm | Max HR: ${activity.max_heartrate} bpm`);
      if (activity.average_watts)
        header.push(`Avg Power: ${activity.average_watts}W | Max Power: ${activity.max_watts}W`);
      if (activity.average_cadence) header.push(`Avg Cadence: ${activity.average_cadence}`);
      if (activity.device_name) header.push(`Device: ${activity.device_name}`);
      if (activity.gear) header.push(`Gear: ${activity.gear.name}`);

      // Strava provides both split series; show the one in the athlete's units.
      const imperial = getDefaultUnits() === "imperial";
      const splitList = (imperial ? activity.splits_standard : activity.splits_metric) ?? [];
      const splits = splitList.length
        ? `\n${imperial ? "Mile" : "Kilometer"} splits:\n${splitList.map(formatSplit).join("\n")}`
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

      return promptText(`${provenance}\n\n${text}`);
    },
  );
}
