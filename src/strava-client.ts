import { STRAVA_API_BASE, STRAVA_TOKEN_URL } from "./constants.js";
import { StravaApiError } from "./errors.js";
import type { TokenResponse } from "./types.js";

/**
 * Parse JSON while converting integers with 16+ digits to strings
 * to prevent precision loss beyond Number.MAX_SAFE_INTEGER.
 * Uses a simple state machine to avoid modifying numbers inside strings.
 */
function safeJsonParse(text: string): unknown {
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
      throw new StravaApiError(
        res.status,
        `Token refresh failed: ${text}`,
      );
    }

    const data = (await res.json()) as TokenResponse;
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function request<T>(
  method: string,
  path: string,
  options?: {
    params?: Record<string, unknown>;
    body?: Record<string, unknown> | FormData;
  },
  retried = false,
): Promise<T> {
  if (!accessToken) {
    await refreshAccessToken();
  }

  const url = new URL(`${STRAVA_API_BASE}${path}`);
  if (options?.params) {
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
  if (options?.body instanceof FormData) {
    requestBody = options.body;
  } else if (options?.body) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.body);
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: requestBody,
  });

  // On 401, try refreshing the token once
  if (res.status === 401 && !retried) {
    await refreshAccessToken();
    return request<T>(method, path, options, true);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new StravaApiError(res.status, text);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await res.text();
    return safeJsonParse(text) as T;
  }
  return (await res.text()) as unknown as T;
}

export function stravaGet<T>(
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return request<T>("GET", path, { params });
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
