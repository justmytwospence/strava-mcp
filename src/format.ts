import { CHARACTER_LIMIT } from "./constants.js";

export function textResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  const truncated =
    text.length > CHARACTER_LIMIT
      ? text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated]"
      : text;
  return { content: [{ type: "text", text: truncated }] };
}

export function jsonResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return textResult(JSON.stringify(data, null, 2));
}

export type Units = "metric" | "imperial";

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

let defaultUnits: Units = "metric";

/** Set the unit system used by format helpers when no explicit units are passed. */
export function setDefaultUnits(units: Units): void {
  defaultUnits = units;
}

export function getDefaultUnits(): Units {
  return defaultUnits;
}

export function formatDistance(
  meters: number,
  units: Units = defaultUnits,
): string {
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

export function formatPace(
  metersPerSecond: number,
  units: Units = defaultUnits,
): string {
  if (metersPerSecond <= 0) return "N/A";
  const distance = units === "imperial" ? METERS_PER_MILE : 1000;
  const label = units === "imperial" ? "/mi" : "/km";
  const secPerUnit = distance / metersPerSecond;
  const min = Math.floor(secPerUnit / 60);
  const sec = Math.round(secPerUnit % 60);
  return `${min}:${sec.toString().padStart(2, "0")} ${label}`;
}

export function formatElevation(
  meters: number,
  units: Units = defaultUnits,
): string {
  if (units === "imperial") {
    return `${Math.round(meters / METERS_PER_FOOT)} ft`;
  }
  return `${Math.round(meters)} m`;
}

export function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
