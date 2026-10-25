/**
 * The token file (STRAVA_TOKEN_FILE): the OAuth token pair the server runs with.
 *
 * Strava may rotate the refresh token on any refresh, so the pair is persisted after
 * every refresh and preferred over the environment at startup. The strava-mcp-auth
 * command writes the first pair. Written atomically with mode 0600.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds at which access_token expires. */
  expires_at: number;
  /** Scopes granted at authorization, as Strava reported them (informational). */
  scope?: string;
  athlete_id?: number;
}

/** The stored pair, or null when the file is missing, unreadable or has no refresh token. */
export function readTokenFile(path: string | undefined): StoredTokens | null {
  if (!path) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredTokens>;
    if (typeof stored.refresh_token !== "string" || !stored.refresh_token) return null;
    return {
      access_token: typeof stored.access_token === "string" ? stored.access_token : "",
      refresh_token: stored.refresh_token,
      expires_at: typeof stored.expires_at === "number" ? stored.expires_at : 0,
      ...(stored.scope ? { scope: stored.scope } : {}),
      ...(stored.athlete_id ? { athlete_id: stored.athlete_id } : {}),
    };
  } catch {
    return null;
  }
}

export function writeTokenFile(path: string, tokens: StoredTokens): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
