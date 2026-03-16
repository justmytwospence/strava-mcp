import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import {
  formatDistance,
  formatDuration,
  formatDate,
} from "../format.js";
import type { DetailedSegment, SegmentEffort } from "../types.js";

export function register(server: McpServer): void {
  server.registerPrompt(
    "segment-comparison",
    {
      title: "Segment Effort Comparison",
      description:
        "Compare all your efforts on a Strava segment over time to identify trends and improvements.",
      argsSchema: {
        segment_id: z
          .string()
          .describe("The Strava segment ID to compare efforts on"),
      },
    },
    async ({ segment_id }) => {
      const segment = await stravaGet<DetailedSegment>(
        `/segments/${segment_id}`,
      );

      const efforts = await stravaGet<SegmentEffort[]>("/segment_efforts", {
        segment_id,
        per_page: 200,
      });

      const segmentInfo = [
        `Segment: ${segment.name}`,
        `Distance: ${formatDistance(segment.distance)}`,
        `Avg Grade: ${segment.average_grade}% | Max Grade: ${segment.maximum_grade}%`,
        `Elevation: ${Math.round(segment.elevation_low)}m - ${Math.round(segment.elevation_high)}m (+${Math.round(segment.total_elevation_gain)}m)`,
        `Total efforts: ${segment.effort_count} | Athletes: ${segment.athlete_count}`,
      ].join("\n");

      let effortsText: string;
      if (efforts.length === 0) {
        effortsText = "No efforts found for this segment.";
      } else {
        const rows = efforts.map((e) => {
          const parts = [
            `  ${formatDate(e.start_date_local)}: ${formatDuration(e.elapsed_time)}`,
          ];
          if (e.average_heartrate)
            parts.push(`    HR: ${e.average_heartrate} avg / ${e.max_heartrate} max`);
          if (e.average_watts) parts.push(`    Power: ${e.average_watts}W avg`);
          if (e.pr_rank) parts.push(`    PR Rank: ${e.pr_rank}`);
          if (e.achievements.length > 0)
            parts.push(
              `    Achievements: ${e.achievements.map((a) => a.type).join(", ")}`,
            );
          return parts.join("\n");
        });
        effortsText =
          `Your ${efforts.length} efforts (newest first):\n` +
          rows.join("\n\n");
      }

      const text = [
        segmentInfo,
        "",
        effortsText,
        "",
        "Please compare my efforts on this segment over time. Analyze trends in elapsed time, heart rate, and power (if available). Identify my best and worst performances, what conditions may have contributed, and suggest pacing strategies for improvement.",
      ].join("\n");

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );
}
