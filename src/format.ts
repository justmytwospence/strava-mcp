import { CHARACTER_LIMIT } from "./constants.js";
import type { Provenance } from "./mirror.js";

export function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  const notice = "\n\n[Response truncated; narrow the request or use SQL aggregates]";
  const truncated = text.length > CHARACTER_LIMIT ? `${text.slice(0, CHARACTER_LIMIT - notice.length)}${notice}` : text;
  return { content: [{ type: "text", text: truncated }] };
}

export function jsonResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const text = JSON.stringify(data, null, 2);
  const result = textResult(text);
  // Do not smuggle an unbounded payload through the structured channel when text was capped.
  return text.length <= CHARACTER_LIMIT
    ? {
        ...result,
        structuredContent:
          data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { data },
      }
    : result;
}

export type Units = "metric" | "imperial";

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;
const KILOGRAMS_PER_POUND = 0.45359237;

let defaultUnits: Units = "metric";

/** Set the unit system used by format helpers when no explicit units are passed. */
export function setDefaultUnits(units: Units): void {
  defaultUnits = units;
}

export function getDefaultUnits(): Units {
  return defaultUnits;
}

export function formatDistance(meters: number, units: Units = defaultUnits): string {
  if (units === "imperial") {
    const miles = meters / METERS_PER_MILE;
    if (miles >= 0.1) {
      return `${miles.toFixed(2)} mi`;
    }
    return `${Math.round(meters / METERS_PER_FOOT)} ft`;
  }
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export function formatPace(metersPerSecond: number, units: Units = defaultUnits): string {
  if (metersPerSecond <= 0) return "N/A";
  const distance = units === "imperial" ? METERS_PER_MILE : 1000;
  const label = units === "imperial" ? "/mi" : "/km";
  const secPerUnit = distance / metersPerSecond;
  const min = Math.floor(secPerUnit / 60);
  const sec = Math.round(secPerUnit % 60);
  return `${min}:${sec.toString().padStart(2, "0")} ${label}`;
}

/** An elevation or elevation gain; pass `signed` to keep a leading + for differences. */
export function formatElevation(meters: number, units: Units = defaultUnits, signed = false): string {
  const value = units === "imperial" ? Math.round(meters / METERS_PER_FOOT) : Math.round(meters);
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value} ${units === "imperial" ? "ft" : "m"}`;
}

export function formatWeight(kilograms: number, units: Units = defaultUnits): string {
  if (units === "imperial") {
    return `${Math.round(kilograms / KILOGRAMS_PER_POUND)} lb`;
  }
  return `${Math.round(kilograms * 10) / 10} kg`;
}

/**
 * A readable date and time. Strava's `start_date_local` is the wall-clock time at
 * the activity with a fake Z suffix, so it is rendered as UTC: rendering it in the
 * process's own zone would shift it.
 */
export function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Where an answer came from, appended to tool results as a second text block. */
export function provenanceText(meta: Provenance): string {
  const when = meta.fetched_at ? ` (fetched from Strava ${meta.fetched_at})` : "";
  const origin = meta.source === "mirror" ? `[served from the local mirror${when}]` : "[fetched from Strava just now]";
  return [
    origin,
    meta.stale ? `[stale: Strava could not be asked: ${meta.stale}]` : "",
    meta.partial ? `[coverage: ${meta.partial}]` : "",
    meta.truncated ? "[Results truncated; narrow the window or query aggregates.]" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** jsonResult plus a provenance line. */
export function mirrorResult(
  data: unknown,
  meta: Provenance,
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const result = jsonResult(data);
  result.content.push(...textResult(provenanceText(meta)).content);
  const structured = { data, _provenance: meta };
  if (result.structuredContent && JSON.stringify(structured).length <= CHARACTER_LIMIT)
    result.structuredContent = structured;
  else delete result.structuredContent;
  return result;
}

/** XML/text exports keep their original first text block; provenance is separate. */
export function mirrorTextResult(data: string, meta: Provenance) {
  const result = textResult(data);
  result.content.push(...textResult(provenanceText(meta)).content);
  const structured = { data, _provenance: meta };
  return {
    ...result,
    ...(JSON.stringify(structured).length <= CHARACTER_LIMIT ? { structuredContent: structured } : {}),
  };
}

/** Page through an already-complete list the way Strava's page/per_page would. */
export function pageOf<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}
