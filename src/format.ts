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

export function formatDistance(meters: number): string {
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

export function formatPace(metersPerSecond: number): string {
  if (metersPerSecond <= 0) return "N/A";
  const secPerKm = 1000 / metersPerSecond;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")} /km`;
}

export function formatElevation(meters: number): string {
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
