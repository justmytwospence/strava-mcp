# Clients

The server speaks [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) at `http://<host>:8000/mcp` (older session-based clients work too) and, with the npm package, stdio. Every HTTP example below sends the bearer token; with the [oauth profile](authentication.md#oauth-21-with-your-identity-provider), drop the header and sign in when the client asks. Replace `<host>` and `<MCP_BEARER_TOKEN>` with yours.

Client configuration formats change; each section links the client's own MCP documentation, which wins when they disagree.

## Claude Code

```sh
claude mcp add --transport http strava http://<host>:8000/mcp \
  --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

`--scope user` makes it available in every project. With OAuth, omit the header and run `/mcp` inside Claude Code to sign in; add `--callback-port <port>` when your provider needs a fixed redirect URI (`http://localhost:<port>/callback`). [Claude Code's MCP docs](https://code.claude.com/docs/en/mcp).

## Claude Desktop

Claude Desktop reaches remote servers through claude.ai's connectors (below) and spawns local ones over stdio from `claude_desktop_config.json` (Settings, Developer, Edit Config). A local stdio server is a second instance with its own mirror and its own share of the rate limits, so this is for a machine that is not already running the container:

```json
{
  "mcpServers": {
    "strava": {
      "command": "npx",
      "args": ["-y", "@justmytwospence/strava-mcp"],
      "env": {
        "STRAVA_CLIENT_ID": "12345",
        "STRAVA_CLIENT_SECRET": "...",
        "STRAVA_TOKEN_FILE": "/Users/you/.strava-mcp/tokens.json",
        "STRAVA_DB_PATH": "/Users/you/.strava-mcp/strava.duckdb"
      }
    }
  }
}
```

Use absolute paths: the working directory of a spawned server is not yours. Write the token file first, with the same paths:

```sh
STRAVA_CLIENT_ID=12345 STRAVA_CLIENT_SECRET=... STRAVA_TOKEN_FILE=/Users/you/.strava-mcp/tokens.json \
  npx -y --package @justmytwospence/strava-mcp strava-mcp-auth
```

The sync runs only while Claude Desktop keeps the server open. [Claude Desktop's MCP docs](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

## claude.ai and the Claude mobile apps

Custom connectors need a public HTTPS URL and OAuth: run the [oauth profile](authentication.md#oauth-21-with-your-identity-provider) behind your reverse proxy, then in claude.ai open Settings, Connectors, Add custom connector, and enter `https://strava.example.com/mcp`. If your provider has no dynamic client registration, enter the client id under the connector's advanced settings. The connector is then available in claude.ai, Claude Desktop and the mobile apps. [Claude's custom connector docs](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp).

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

[Cursor's MCP docs](https://cursor.com/docs/context/mcp).

## VS Code

VS Code's own format (`.vscode/mcp.json` in a workspace, or the user `mcp.json` through *MCP: Open User Configuration*) uses a top-level `servers` object:

```json
{
  "servers": {
    "strava": {
      "type": "http",
      "url": "http://<host>:8000/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

The tools appear in Copilot's agent mode. The portable Copilot format (`~/.copilot/mcp-config.json`) uses `mcpServers` with the same entry. [VS Code's MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

## OpenAI Codex

Codex CLI, the IDE extension and the ChatGPT desktop app share `~/.codex/config.toml`:

```toml
[mcp_servers.strava]
url = "https://strava.example.com/mcp"
bearer_token_env_var = "STRAVA_MCP_TOKEN"
```

with `STRAVA_MCP_TOKEN` set to the bearer in Codex's environment (or `http_headers = { "Authorization" = "Bearer ..." }`). For a local stdio instance instead, `command = "npx"`, `args = ["-y", "@justmytwospence/strava-mcp"]` and an `[mcp_servers.strava.env]` table with the variables from the Claude Desktop example. [Codex's MCP docs](https://developers.openai.com/codex/mcp).

## ChatGPT

ChatGPT's connectors (Settings, Connectors, with developer mode enabled under Advanced) accept a remote server over HTTPS with OAuth: the [oauth profile](authentication.md#oauth-21-with-your-identity-provider) behind your reverse proxy, as for claude.ai. The ChatGPT desktop app can also use the Codex configuration above. [OpenAI's connector docs](https://platform.openai.com/docs/mcp).

## Gemini CLI

In `~/.gemini/settings.json` (or the project's `.gemini/settings.json`), `httpUrl` selects Streamable HTTP:

```json
{
  "mcpServers": {
    "strava": {
      "httpUrl": "http://<host>:8000/mcp",
      "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
    }
  }
}
```

[Gemini CLI's MCP docs](https://geminicli.com/docs/tools/mcp-server/).

## Other clients

### pi

`pi mcp add strava --url http://<host>:8000/mcp --bearer-token-env-var STRAVA_MCP_TOKEN` writes the entry to `~/.pi/agent/mcp.json`, reading the bearer from that environment variable; the equivalent by hand:

```json
{
  "mcpServers": {
    "strava": {
      "url": "http://<host>:8000/mcp",
      "headers": { "Authorization": "Bearer ${STRAVA_MCP_TOKEN}" },
      "description": "The athlete's Strava history: activities, streams, segments, routes, SQL over the mirror"
    }
  }
}
```

`pi mcp list` checks the connection; `/mcp` inside a session inspects it. By default pi exposes a server's tools to the model through `codemode` scripts; `"exposure": "direct"` declares them like built-in tools, and `toolExposure` can single out a few (`"strava_query": "direct"`). With OAuth, drop `headers`; pi registers itself with the provider when it supports dynamic registration, or takes a registered client: `"oauth": { "clientId": "strava-mcp", "callbackPort": <port> }`, whose redirect URI is `http://127.0.0.1:<port>/callback`. `pi mcp login strava` signs in outside a session. [pi's MCP docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).

### Anything else

Anything that speaks Streamable HTTP works: point it at `/mcp` with the `Authorization` header. The MCP Inspector is a quick check:

```sh
npx -y @modelcontextprotocol/inspector --transport http --server-url http://<host>:8000/mcp \
  --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
```

The [FAQ](faq.md#what-does-the-model-provider-see) explains what a hosted client's model provider sees.
