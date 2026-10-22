/**
 * Process-wide state shared by every MCP session: the HTTP transport builds a fresh
 * server per request, so the mirror lives here rather than on the server.
 */
import type { Mirror } from "./mirror.js";

let current: Mirror | null = null;

export function setMirror(m: Mirror): void {
  current = m;
}

export function mirror(): Mirror {
  if (!current) throw new Error("The Strava mirror is not initialized");
  return current;
}
