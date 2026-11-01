# @apinator/mcp

[![npm version](https://img.shields.io/npm/v/@apinator/mcp.svg)](https://www.npmjs.com/package/@apinator/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/apinator-io/sdk-mcp/test.yml?label=CI)](https://github.com/apinator-io/sdk-mcp/actions/workflows/test.yml)

[Model Context Protocol](https://modelcontextprotocol.io) server for [Apinator](https://apinator.io).
It lets an AI agent (Claude Code, Claude Desktop, Cursor, …) publish events, inspect channels,
watch live traffic and set up webhooks on your Apinator app, so it can build and debug realtime
features end to end.

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
| `APINATOR_READ_ONLY` | no | `1` removes `publish_event` and the webhook write tools, so the agent can only observe |
| `APINATOR_API_URL` | no | REST base URL of a local or self-hosted data plane (default `https://ws-{cluster}.apinator.io`) |
| `APINATOR_WS_URL` | no | WebSocket base URL of a local or self-hosted data plane (default `wss://ws-{cluster}.apinator.io`) |
| `APINATOR_CONTROL_URL` | no | Base URL of a local or self-hosted control plane, used by the webhook tools (default `https://api.apinator.io`) |

The server checks these at startup and exits with a message naming anything missing or malformed.

## Tools

| Tool | What it does |
|---|---|
| `publish_event` | Publish an event to a channel, or up to 100 channels. `data` can be an object or array (sent as JSON) or a string. Optional `socket_id` excludes the sender. `realtime:` event names are rejected. Not available in read-only mode. |
| `list_channels` | Active channels (with at least one subscriber) and their subscriber counts, optionally filtered by `prefix`. |
| `get_channel` | One channel's subscriber count, or `active: false` when nobody is subscribed. |
| `sign_channel_auth` | The `auth` (and `channel_data`) your auth endpoint should return for a `private-` or `presence-` subscription. Handy for testing an auth flow or debugging a signature mismatch. |
| `list_webhooks` | The app's webhook endpoints (max 10): id, URL, events, enabled. Signing secrets are never listed. |
| `add_webhook` | Register an endpoint `url` for `events` (`channel_occupied`, `channel_vacated`, `member_added`, `member_removed`). Returns its `whsec_` signing secret, **shown only this once**, for the app's environment. Refuses a URL that is already registered. Not available in read-only mode. |
| `edit_webhook` | Change an endpoint's `url`, `events` or `enabled`. The secret stays the same. Not available in read-only mode. |
| `delete_webhook` | Delete an endpoint. Not available in read-only mode. |
| `test_webhook` | Send one signed `webhook.test` event now and report the receiver's status and timing. Not available in read-only mode. |
| `list_webhook_deliveries` | Recent deliveries to one endpoint (status, attempts, last error), optionally filtered by `status`. |
| `watch_channel` | Connects over WebSocket, subscribes (signing private/presence auth itself), and collects events for `seconds` (default 10, max 60). Keeps up to `max_events` (default 50, max 200); `until_events` returns early. Sends MCP progress notifications every 5 seconds, so clients that reset their timeout on progress can wait out a long watch. On presence channels the watcher joins as a member, which other subscribers will see. |

`list_channels`, `get_channel`, `sign_channel_auth`, `watch_channel`, `list_webhooks` and
`list_webhook_deliveries` are annotated `readOnlyHint`, so clients can auto-approve them;
`delete_webhook` is annotated `destructiveHint`.

A typical end-to-end check an agent runs: start `watch_channel` on a channel, trigger the code path
that publishes (or call `publish_event`), and compare the payload with what the client expects.
On `cache-` channels the last event is replayed to new subscribers, so a watch started after a publish
still receives it.

### Webhooks

The webhook tools call the control plane (`https://api.apinator.io`), signed with the same app key and
secret, and only ever touch this app's endpoints. A typical setup: add a POST route that verifies the
raw body with `verifyWebhook` from the server SDK and returns 2xx, `add_webhook` with its public URL, store
the returned secret as `APINATOR_WEBHOOK_SECRET`, then `test_webhook`. Webhook URLs must be reachable from
the internet; private and loopback addresses are refused, so expose a local dev server with a tunnel
(cloudflared, ngrok). Secret rotation and delivery retries stay in the console.

## Resources and prompts

- `apinator://docs/llms.txt`: the Apinator docs index, fetched from https://apinator.io/llms.txt.
- `apinator://reference/protocol`: frames, system events, error codes, channel types and the auth signature.
- Prompt `add-realtime-feature`: walks the agent through choosing channels, wiring the server and client
  SDKs, verifying with `watch_channel`, and adding a webhook receiver when the backend needs one.

## Security

- The secret stays in the server process. Tool results and errors are scrubbed of it, and API error
  bodies are shortened to a one-line message.
- `publish_event` reaches every subscriber of the channel. Set `APINATOR_READ_ONLY=1` for an agent that
  should only look, or use a separate app for development.
- `sign_channel_auth` produces valid subscription signatures for any channel name. Only give the server
  to agents you would trust with your app's auth endpoint.
- The app secret can manage the app's webhooks. Anyone holding it can point an endpoint at their own URL
  and receive channel names and presence `user_id`s from then on, so treat it like any server secret.
  It cannot read an existing endpoint's signing secret (only `add_webhook` returns one, once), so it cannot
  forge deliveries to a receiver you already set up. `APINATOR_READ_ONLY=1` removes every webhook write tool.

## Development

```bash
npm install
npm run build
npm test                  # unit tests (mocked fetch, local fake WebSocket server)
npm run typecheck         # src and tests
```

Releases are cut by [release-please](https://github.com/googleapis/release-please) from Conventional
Commits on `main`; the release PR bumps `package.json`, updates `CHANGELOG.md` and tags, and the
workflow then publishes to npm.

Maintainers with the Apinator backend checked out next to this repo (`../../backend`, or set
`BACKEND_DIR`) can run the integration test and the MCP inspector against a throwaway local stack:

```bash
./scripts/local-stack.sh up       # builds the backend, starts Postgres/Redis in Docker on spare ports, seeds an app
npm run build && npm run test:integration
./scripts/local-stack.sh down
```

`local-stack.sh up` writes the local credentials to `.local-stack/env`. It also sets
`APINATOR_API_URL`, `APINATOR_WS_URL` and `APINATOR_CONTROL_URL`, which point the server at a
non-production stack. Its control plane allows private webhook targets, so the integration test can
register a receiver on localhost.

## License

MIT
