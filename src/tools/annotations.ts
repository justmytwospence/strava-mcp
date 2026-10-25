/**
 * Tool annotations (MCP's hints to clients about what a tool does), shared so every
 * tool of a kind says the same thing.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/server";

/** Reads Strava data: served from the mirror, fetched from Strava when stale. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Reads only the mirror; never contacts Strava. */
export const LOCAL_READ_ONLY: ToolAnnotations = {
  ...READ_ONLY,
  openWorldHint: false,
};

/** Creates something on Strava; calling it twice creates two. */
export const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Changes something on Strava; calling it twice with the same input changes nothing more. */
export const UPDATE: ToolAnnotations = {
  ...CREATE,
  idempotentHint: true,
};
