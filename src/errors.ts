export class StravaApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "StravaApiError";
  }
}

export function formatToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  let message: string;

  if (error instanceof StravaApiError) {
    switch (error.statusCode) {
      case 401:
        message = `Authentication failed (401). Your access token may be expired. Ensure STRAVA_ACCESS_TOKEN and STRAVA_REFRESH_TOKEN are set correctly.`;
        break;
      case 403:
        message = `Forbidden (403). You may not have the required scope for this operation. ${error.message}`;
        break;
      case 404:
        message = `Not found (404). The requested resource does not exist. ${error.message}`;
        break;
      case 429:
        message = `Rate limit exceeded (429). ${error.message}`;
        break;
      default:
        message = `Strava API error (${error.statusCode}): ${error.message}`;
    }
  } else if (error instanceof Error) {
    message = `Error: ${error.message}`;
  } else {
    message = `Unknown error: ${String(error)}`;
  }

  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
