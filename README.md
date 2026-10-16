# @apinator/mcp

[![npm version](https://img.shields.io/npm/v/@apinator/mcp.svg)](https://www.npmjs.com/package/@apinator/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/apinator-io/sdk-mcp/test.yml?label=CI)](https://github.com/apinator-io/sdk-mcp/actions/workflows/test.yml)

[Model Context Protocol](https://modelcontextprotocol.io) server for [Apinator](https://apinator.io).
It lets an AI agent (Claude Code, Claude Desktop, Cursor, …) publish events, inspect channels and
watch live traffic on your Apinator app, so it can build and debug realtime features end to end.

## Setup

You need your app's ID, key, secret and cluster from the [Apinator console](https://console.apinator.io).
Node.js 18 or newer.

**Claude Code**

```bash
claude mcp add apinator \
  -e APINATOR_APP_ID=your-app-id \
  -e APINATOR_KEY=your-key \
  -e APINATOR_SECRET=your-secret \
  -e APINATOR_CLUSTER=eu \
  -- npx -y @apinator/mcp
```

**Claude Desktop, Cursor and other clients** (`mcpServers` JSON config)

```json
{
  "mcpServers": {
    "apinator": {
      "command": "npx",
      "args": ["-y", "@apinator/mcp"],
      "env": {
        "APINATOR_APP_ID": "your-app-id",
        "APINATOR_KEY": "your-key",
        "APINATOR_SECRET": "your-secret",
        "APINATOR_CLUSTER": "eu"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `APINATOR_APP_ID` | yes | App ID |
| `APINATOR_KEY` | yes | API key |
| `APINATOR_SECRET` | yes | API secret. Used to sign requests; never returned by any tool |
| `APINATOR_CLUSTER` | yes | Region the app was created in, e.g. `eu` or `us` |
| `APINATOR_READ_ONLY` | no | `1` removes `publish_event`, so the agent can only observe |

The server checks these at startup and exits with a message naming anything missing or malformed.

## Tools

| Tool | What it does |
|---|---|
| `publish_event` | Publish an event to a channel, or up to 100 channels. `data` can be an object (sent as JSON) or a string. Optional `socket_id` excludes the sender. `realtime:` event names are rejected. Not available in read-only mode. |
| `list_channels` | Active channels (with at least one subscriber) and their subscriber counts, optionally filtered by `prefix`. |
| `get_channel` | One channel's subscriber count, or `active: false` when nobody is subscribed. |
| `sign_channel_auth` | The `auth` (and `channel_data`) your auth endpoint should return for a `private-` or `presence-` subscription. Handy for testing an auth flow or debugging a signature mismatch. |
| `watch_channel` | Connects over WebSocket, subscribes (signing private/presence auth itself), and collects events for `seconds` (default 10, max 60). Keeps up to `max_events` (default 50, max 200); `until_events` returns early. On presence channels the watcher joins as a member, which other subscribers will see. |

Every tool except `publish_event` is annotated `readOnlyHint`, so clients can auto-approve them.

A typical end-to-end check an agent runs: start `watch_channel` on a channel, trigger the code path
that publishes (or call `publish_event`), and compare the payload with what the client expects.
On `cache-` channels the last event is replayed to new subscribers, so a watch started after a publish
still receives it.

## Resources and prompts

- `apinator://docs/llms.txt`: the Apinator docs index, fetched from https://apinator.io/llms.txt.
- `apinator://reference/protocol`: frames, system events, error codes, channel types and the auth signature.
- Prompt `add-realtime-feature`: walks the agent through choosing channels, wiring the server and client
  SDKs, and verifying with `watch_channel`.

## Security

- The secret stays in the server process. Tool results and errors are scrubbed of it, and API error
  bodies are shortened to a one-line message.
- `publish_event` reaches every subscriber of the channel. Set `APINATOR_READ_ONLY=1` for an agent that
  should only look, or use a separate app for development.
- `sign_channel_auth` produces valid subscription signatures for any channel name. Only give the server
  to agents you would trust with your app's auth endpoint.

## Development

```bash
npm install
npm run build
npm test                  # unit tests (mocked fetch, local fake WebSocket server)
npm run typecheck
```

Maintainers with the Apinator backend checked out next to this repo (`../../backend`, or set
`BACKEND_DIR`) can run the integration test and the MCP inspector against a throwaway local stack:

```bash
./scripts/local-stack.sh up       # builds the backend, starts Postgres/Redis in Docker on spare ports, seeds an app
npm run build && npm run test:integration
./scripts/local-stack.sh down
```

`local-stack.sh up` writes the local credentials to `.local-stack/env`. It also sets
`APINATOR_API_URL` and `APINATOR_WS_URL`, which point the server at a non-production data plane.

## License

MIT
