import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatDate, formatDistance, formatDuration, formatElevation, formatWeight } from "../format.js";
import type { AthleteStats, DetailedAthlete, SummaryActivity } from "../types.js";
import { contextNote, localContext, promptText } from "./context.js";

function formatActivityTotal(
  label: string,
  t: { count: number; distance: number; moving_time: number; elevation_gain: number },
): string {
  if (t.count === 0) return `${label}: no activities`;
  return `${label}: ${t.count} activities | ${formatDistance(t.distance)} | ${formatDuration(t.moving_time)} | ${formatElevation(t.elevation_gain)} gain`;
}

export function register(server: McpServer): void {
  server.registerPrompt(
    "race-readiness",
    {
      title: "Race Readiness Assessment",
      description:
        "Assess readiness using stored profile/stats and up to 200 activities over 90 days. Local only, zero API calls; preserve coverage limitations and refresh via tools separately.",
      argsSchema: z.object({
        distance: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Target race distance (e.g. '5k', '10k', 'half marathon', 'marathon')"),
      }),
    },
    async ({ distance }) => {
      const m = localContext();
      const athleteResult = await m.athlete();
      const statsResult = await m.athleteStats();
      const athlete = athleteResult.data as DetailedAthlete;
      const stats = statsResult.data as AthleteStats;

      const after = Math.floor(Date.now() / 1000) - 90 * 86400;
      const activitiesResult = await m.listActivities({ after, page: 1, perPage: 200 });
      const activities = activitiesResult.data as SummaryActivity[];

      const profile = [
        `Athlete: ${athlete.firstname} ${athlete.lastname}`,
        athlete.weight ? `Weight: ${formatWeight(athlete.weight)}` : null,
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
          (a) => a.sport_type === "Run" || a.sport_type === "TrailRun" || a.sport_type === "VirtualRun",
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

        const recent = activities
          .slice(0, 10)
          .map(
            (a) =>
              `  - ${formatDate(a.start_date_local)}: ${a.name} (${a.sport_type}) | ${formatDistance(a.distance)} | ${formatDuration(a.moving_time)}`,
          );

        recentText = [
          `Last 90 days (${activities.length} total activities):`,
          formatGroup("  Runs", runs),
          formatGroup("  Rides", rides),
          "",
          "Most recent activities (display limited to 10; totals above use the returned page):",
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

      return promptText(`${contextNote(athleteResult, statsResult, activitiesResult)}\n\n${text}`);
    },
  );
}
