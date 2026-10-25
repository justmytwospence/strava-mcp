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
        message = `Authentication failed (401). Strava rejected the token and a refresh did not help: the athlete may have revoked the application. Re-run strava-mcp-auth (with Compose: docker compose run --rm -p 8765:8765 strava-mcp auth) to authorize again.`;
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
