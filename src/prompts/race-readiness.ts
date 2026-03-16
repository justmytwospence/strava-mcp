import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stravaGet } from "../strava-client.js";
import {
  formatDistance,
  formatDuration,
  formatDate,
} from "../format.js";
import type {
  DetailedAthlete,
  AthleteStats,
  SummaryActivity,
} from "../types.js";

function formatActivityTotal(label: string, t: { count: number; distance: number; moving_time: number; elevation_gain: number }): string {
  if (t.count === 0) return `${label}: no activities`;
  return `${label}: ${t.count} activities | ${formatDistance(t.distance)} | ${formatDuration(t.moving_time)} | ${Math.round(t.elevation_gain)}m gain`;
}

export function register(server: McpServer): void {
  server.registerPrompt(
    "race-readiness",
    {
      title: "Race Readiness Assessment",
      description:
        "Assess fitness and race readiness based on recent training history and athlete stats.",
      argsSchema: {
        distance: z
          .string()
          .optional()
          .describe(
            "Target race distance (e.g. '5k', '10k', 'half marathon', 'marathon')",
          ),
      },
    },
    async ({ distance }) => {
      const athlete = await stravaGet<DetailedAthlete>("/athlete");
      const stats = await stravaGet<AthleteStats>(
        `/athletes/${athlete.id}/stats`,
      );

      const after = Math.floor(Date.now() / 1000) - 90 * 86400;
      const activities = await stravaGet<SummaryActivity[]>(
        "/athlete/activities",
        { after, per_page: 200 },
      );

      const profile = [
        `Athlete: ${athlete.firstname} ${athlete.lastname}`,
        athlete.weight ? `Weight: ${athlete.weight}kg` : null,
        athlete.ftp ? `FTP: ${athlete.ftp}W` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const statsText = [
        "Year-to-date totals:",
        formatActivityTotal("  Rides", stats.ytd_ride_totals),
        formatActivityTotal("  Runs", stats.ytd_run_totals),
        formatActivityTotal("  Swims", stats.ytd_swim_totals),
        "",
        "All-time totals:",
        formatActivityTotal("  Rides", stats.all_ride_totals),
        formatActivityTotal("  Runs", stats.all_run_totals),
        formatActivityTotal("  Swims", stats.all_swim_totals),
      ].join("\n");

      let recentText: string;
      if (activities.length === 0) {
        recentText = "No activities in the last 90 days.";
      } else {
        const runs = activities.filter(
          (a) =>
            a.sport_type === "Run" ||
            a.sport_type === "TrailRun" ||
            a.sport_type === "VirtualRun",
        );
        const rides = activities.filter(
          (a) =>
            a.sport_type === "Ride" ||
            a.sport_type === "VirtualRide" ||
            a.sport_type === "MountainBikeRide" ||
            a.sport_type === "GravelRide",
        );

        const formatGroup = (label: string, acts: SummaryActivity[]) => {
          if (acts.length === 0) return `${label}: none`;
          const totalDist = acts.reduce((s, a) => s + a.distance, 0);
          const totalTime = acts.reduce((s, a) => s + a.moving_time, 0);
          const longest = Math.max(...acts.map((a) => a.distance));
          return `${label}: ${acts.length} activities | ${formatDistance(totalDist)} total | ${formatDuration(totalTime)} | longest: ${formatDistance(longest)}`;
        };

        const recent = activities.slice(0, 10).map(
          (a) =>
            `  - ${formatDate(a.start_date_local)}: ${a.name} (${a.sport_type}) | ${formatDistance(a.distance)} | ${formatDuration(a.moving_time)}`,
        );

        recentText = [
          `Last 90 days (${activities.length} total activities):`,
          formatGroup("  Runs", runs),
          formatGroup("  Rides", rides),
          "",
          "Most recent activities:",
          ...recent,
        ].join("\n");
      }

      const target = distance
        ? `Target race distance: ${distance}`
        : "No specific race distance specified - provide a general fitness assessment.";

      const text = [
        profile,
        "",
        statsText,
        "",
        recentText,
        "",
        target,
        "",
        "Please assess my race readiness. Evaluate training volume, longest recent efforts, consistency, and overall fitness trajectory. Identify strengths and gaps in preparation, and suggest what to focus on in the remaining training period.",
      ].join("\n");

      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );
}
