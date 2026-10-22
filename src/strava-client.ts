import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STRAVA_API_BASE, STRAVA_TOKEN_URL } from "./constants.js";
import { StravaApiError } from "./errors.js";
import { type Priority, RateLimiter } from "./sync/rate-limit.js";
import type { TokenResponse } from "./types.js";

/** Every request goes through this limiter; the sync engine reads its status. */
export const limiter = new RateLimiter();

/** Raised when a request would have to wait longer than its caller allows. */
export class RateLimitWaitError extends Error {
  constructor(public readonly delayMs: number) {
    super(`Strava rate limit: the next request of this kind is allowed in ${Math.ceil(delayMs / 1000)}s`);
    this.name = "RateLimitWaitError";
  }
}

/**
 * Parse JSON while converting integers with 16+ digits to strings
 * to prevent precision loss beyond Number.MAX_SAFE_INTEGER.
 * Uses a simple state machine to avoid modifying numbers inside strings.
 */
export function safeJsonParse(text: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
    } else if (ch === '"') {
      inString = true;
      result += ch;
      i++;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let numStr = "";
      while (i < text.length && /[\d.eE+\-]/.test(text[i])) {
        numStr += text[i];
        i++;
      }
      if (numStr.length >= 16 && /^-?\d+$/.test(numStr)) {
        result += `"${numStr}"`;
      } else {
        result += numStr;
      }
    } else {
      result += ch;
      i++;
    }
  }

  return JSON.parse(result);
}

let accessToken = process.env.STRAVA_ACCESS_TOKEN ?? "";
let refreshToken = process.env.STRAVA_REFRESH_TOKEN ?? "";
let refreshPromise: Promise<void> | null = null;

/**
 * Optional token store. Strava can rotate the refresh token on any refresh, which
 * would leave the one in the environment dead after the next restart. With
 * STRAVA_TOKEN_FILE set, the latest pair is written there and preferred at startup.
 */
const tokenFile = process.env.STRAVA_TOKEN_FILE;

function loadStoredTokens(): void {
  if (!tokenFile) return;
  try {
    const stored = JSON.parse(readFileSync(tokenFile, "utf8")) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (stored.refresh_token) {
      refreshToken = stored.refresh_token;
      accessToken = stored.access_token ?? "";
    }
  } catch {
    // No store yet (first run) or unreadable: fall back to the environment.
  }
}

function saveTokens(data: TokenResponse): void {
  if (!tokenFile) return;
  try {
    mkdirSync(dirname(tokenFile), { recursive: true });
    const tmp = `${tokenFile}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, tokenFile);
  } catch (err) {
    console.error(`Could not write STRAVA_TOKEN_FILE (${tokenFile}):`, err);
  }
}

loadStoredTokens();

const clientId = process.env.STRAVA_CLIENT_ID ?? "";
const clientSecret = process.env.STRAVA_CLIENT_SECRET ?? "";

async function refreshAccessToken(): Promise<void> {
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error(
      "Cannot refresh token. Ensure STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and STRAVA_REFRESH_TOKEN are set.",
    );
  }

  // Mutex: if a refresh is already in-flight, wait for it
  if (refreshPromise) {
    await refreshPromise;
    return;
  }

  refreshPromise = (async () => {
    const res = await fetch(STRAVA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new StravaApiError(res.status, `Token refresh failed: ${text}`);
    }

    const data = (await res.json()) as TokenResponse;
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    saveTokens(data);
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export interface RequestOptions {
  params?: Record<string, unknown>;
  body?: Record<string, unknown> | FormData;
  /** Rate-limit class; tools are interactive, the sync worker background. */
  priority?: Priority;
  /** Give up with RateLimitWaitError rather than wait longer than this. */
  maxWaitMs?: number;
}

/** The response body as text, exactly as Strava sent it, plus its status. */
export async function requestRaw(
  method: string,
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<{ status: number; text: string; contentType: string }> {
  if (!accessToken) {
    await refreshAccessToken();
  }
  const priority = options.priority ?? "interactive";
  if (!(await limiter.acquire(priority, method, path, options.maxWaitMs))) {
    throw new RateLimitWaitError(limiter.delayFor(priority, method, path));
  }

  const url = new URL(`${STRAVA_API_BASE}${path}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  let requestBody: string | FormData | undefined;
  if (options.body instanceof FormData) {
    requestBody = options.body;
  } else if (options.body) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.body);
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: requestBody,
  });
  limiter.observe(method, path, res.status, res.headers, priority);

  // On 401, try refreshing the token once
  if (res.status === 401 && !retried) {
    await refreshAccessToken();
    return requestRaw(method, path, options, true);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new StravaApiError(res.status, text);
  }
  return { status: res.status, text, contentType: res.headers.get("content-type") ?? "" };
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { text, contentType } = await requestRaw(method, path, options);
  if (contentType.includes("application/json")) {
    return safeJsonParse(text) as T;
  }
  return text as unknown as T;
}

export function stravaGet<T>(
  path: string,
  params?: Record<string, unknown>,
  options: Omit<RequestOptions, "params" | "body"> = {},
): Promise<T> {
  return request<T>("GET", path, { ...options, params });
}

export function stravaPost<T>(
  path: string,
  body?: Record<string, unknown> | FormData,
): Promise<T> {
  return request<T>("POST", path, { body });
}

export function stravaPut<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  return request<T>("PUT", path, { body });
}
