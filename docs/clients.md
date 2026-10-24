# Clients

The server speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) at `http://<host>:8000/mcp` and also accepts older session-based clients. Every example below uses the bearer token; with the [oauth profile](authentication.md#oauth-21-with-your-identity-provider) drop the header and sign in when the client asks.

## Claude Code

```sh
claude mcp add --transport http strava http://<host>:8000/mcp \
  --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

`--scope user` makes it available in every project. With OAuth, omit the header and run `/mcp` inside Claude Code to sign in; add `--callback-port 3118` when your provider needs a fixed redirect port.

## claude.ai, Claude Desktop and mobile

The hosted Claude apps connect through claude.ai's custom connectors, which need a public HTTPS URL and OAuth: run the [oauth profile](authentication.md#oauth-21-with-your-identity-provider) behind your reverse proxy, then in claude.ai open Settings, Connectors, Add custom connector, and enter `https://strava.example.com/mcp`. The same connector is then available in Claude Desktop and the mobile apps.

Claude Desktop can also spawn a local server over stdio. This runs a second instance with its own mirror and its own share of the rate limits, so it is only for a machine that is not already running the container:

```json
{
  "mcpServers": {
    "strava": {
      "command": "npx",
      "args": ["-y", "strava-mcp-server"],
      "env": {
        "STRAVA_CLIENT_ID": "12345",
        "STRAVA_CLIENT_SECRET": "...",
        "STRAVA_TOKEN_FILE": "/Users/you/.strava-mcp/tokens.json"
      }
    }
  }
}
```

Write the token file first with `STRAVA_CLIENT_ID=12345 STRAVA_CLIENT_SECRET=... STRAVA_TOKEN_FILE=/Users/you/.strava-mcp/tokens.json npx -y --package strava-mcp-server strava-mcp-auth`. The mirror lives in `./state/strava.duckdb` relative to the working directory unless `STRAVA_DB_PATH` says otherwise.

## Cursor

In `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "strava": {
      "url": "http://<host>:8000/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

## pi

pi reads `~/.pi/agent/mcp.json` in the same shape:

```json
{
  "mcpServers": {
    "strava": {
      "type": "http",
      "url": "http://<host>:8000/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

With OAuth, replace `headers` with `"oauth": { "clientId": "strava-mcp", "callbackPort": 3118 }` and register that port's callback at your provider.

## Any other client

Anything that speaks Streamable HTTP works: point it at `/mcp` with the `Authorization` header. The MCP Inspector is a quick check:

```sh
npx -y @modelcontextprotocol/inspector --transport http --server-url http://<host>:8000/mcp \
  --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

## What to ask

The server exposes [33 tools](reference/tools.md), including `strava_query`, which runs read-only SQL over the whole mirror, and `strava_schema`, which describes it. Models do well with questions like "how did my running volume change over the last three months", "compare my efforts on segment 1234", "what was my heart rate drift in yesterday's long run", because the answer is a query over the typed tables rather than a dozen API calls. The [prompts](reference/tools.md#prompts) package the common ones.
