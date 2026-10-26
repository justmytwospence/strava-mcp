import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDate, formatDistance, formatDuration, formatElevation } from "../format.js";
import type { DetailedSegment, SegmentEffort } from "../types.js";
import { stringId } from "../validation.js";
import { contextNote, localContext, promptText } from "./context.js";

export function register(server: McpServer): void {
  server.registerPrompt(
    "segment-comparison",
    {
      title: "Segment Effort Comparison",
      description:
        "Compare up to 200 stored efforts on a segment with coverage/provenance, not necessarily all efforts. Local only, zero API calls; refresh via tools separately.",
      argsSchema: z.object({
        segment_id: stringId.describe("The Strava segment ID to compare efforts on"),
      }),
    },
    async ({ segment_id }) => {
      const m = localContext();
      const segmentResult = await m.segment(segment_id);
      const effortsResult = await m.segmentEfforts(segment_id, {}, 200);
      const segment = segmentResult.data as DetailedSegment;
      const efforts = effortsResult.data as SegmentEffort[];

      const segmentInfo = [
        `Segment: ${segment.name}`,
        `Distance: ${formatDistance(segment.distance)}`,
        `Avg Grade: ${segment.average_grade}% | Max Grade: ${segment.maximum_grade}%`,
        `Elevation: ${formatElevation(segment.elevation_low)} - ${formatElevation(segment.elevation_high)} (${formatElevation(segment.total_elevation_gain, undefined, true)})`,
        `Total efforts: ${segment.effort_count} | Athletes: ${segment.athlete_count}`,
      ].join("\n");

      let effortsText: string;
      if (efforts.length === 0) {
        effortsText = "No efforts found for this segment.";
      } else {
        const rows = efforts.map((e) => {
          const parts = [`  ${formatDate(e.start_date_local)}: ${formatDuration(e.elapsed_time)}`];
          if (e.average_heartrate) parts.push(`    HR: ${e.average_heartrate} avg / ${e.max_heartrate} max`);
          if (e.average_watts) parts.push(`    Power: ${e.average_watts}W avg`);
          if (e.pr_rank) parts.push(`    PR Rank: ${e.pr_rank}`);
          if (e.achievements.length > 0)
            parts.push(`    Achievements: ${e.achievements.map((a) => a.type).join(", ")}`);
          return parts.join("\n");
        });
        effortsText = `Your ${efforts.length} efforts (newest first):\n${rows.join("\n\n")}`;
      }

      const text = [
        segmentInfo,
        "",
        effortsText,
        "",
        "Please compare my efforts on this segment over time. Analyze trends in elapsed time, heart rate, and power (if available). Identify my best and worst performances, what conditions may have contributed, and suggest pacing strategies for improvement.",
      ].join("\n");

      return promptText(`${contextNote(segmentResult, effortsResult)}\n\n${text}`);
    },
  );
}
