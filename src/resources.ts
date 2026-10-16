import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const LLMS_TXT_URL = "https://apinator.io/llms.txt";
const DOCS_CACHE_MS = 60 * 60 * 1000;
const DOCS_FETCH_TIMEOUT_MS = 5_000;

/** Short, bundled reference for the wire protocol and channel types. */
export const PROTOCOL_REFERENCE = `# Apinator protocol and channel reference

## Endpoints
- WebSocket: wss://ws-{cluster}.apinator.io/app/{key}?protocol=7
- REST (signed with HMAC-SHA256): https://ws-{cluster}.apinator.io
  - POST /apps/{app_id}/events — publish. Body: {"name", "channel" | "channels" (max 100), "data" (string), "socket_id"?}
  - GET  /apps/{app_id}/channels?filter_by_prefix=… — active channels with subscription_count
  - GET  /apps/{app_id}/channels/{name} — one channel; 404 when nobody is subscribed

## Frames
Every WebSocket frame is JSON: {"event": "...", "channel": "...", "data": "<string>"}.
\`data\` is always a string; for system events it holds JSON.

Server → client:
- realtime:connection_established — data {"socket_id", "activity_timeout"}
- realtime:subscription_succeeded — per channel; on presence channels data holds {"presence": {"count", "ids", "hash"}}
- realtime:subscription_error — data {"type", "error", "status"}
- realtime:member_added / realtime:member_removed — presence membership changes
- realtime:pong — reply to a client ping
- realtime:error — data {"code", "message"}. Codes 4000–4099 are fatal (bad key, app disabled, wrong cluster),
  4100–4199 mean retry later (limits), 4200–4299 mean reconnect now, 4301 rate limited,
  4302 client events disabled for this app (non-fatal, event not relayed).

Client → server:
- realtime:subscribe — data {"channel", "auth"?, "channel_data"?}
- realtime:unsubscribe — data {"channel"}
- realtime:ping
- client-* events on private/presence channels, relayed to other subscribers (if enabled for the app)

Event names starting with "realtime:" are reserved; your own events can use any other name.

## Channel types (by name prefix)
| Prefix | Auth | Notes |
|---|---|---|
| (none), e.g. "orders" | none | Anyone with the key can subscribe |
| private- | signed | Your auth endpoint signs each subscription |
| presence- | signed + channel_data | Tracks members: {"user_id": "<string>", "user_info": {...}} |
| cache- | none | Server replays the last event to each new subscriber |
| private-cache- | signed | Private + last-event replay |
| presence-cache- | signed | Known issues; avoid for now |

## Channel auth
signature = hex(HMAC-SHA256(secret, "{socket_id}:{channel}" or "{socket_id}:{channel}:{channel_data}"))
auth = "{key}:{signature}". Your server returns {"auth", "channel_data"?} from its auth endpoint;
the client sends both in realtime:subscribe. Never ship the secret to browsers.

## Server SDKs
Node @apinator/server, Python apinator-server, Go github.com/apinator-io/sdk-go, PHP apinator/apinator-php.
Client SDKs: JavaScript @apinator/client, Swift ApinatorSDK.
`;

interface ResourceDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Registers the docs and protocol reference resources. */
export function registerResources(server: McpServer, deps: ResourceDeps = {}): void {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? Date.now;
  let cached: { text: string; at: number } | undefined;

  server.registerResource(
    "apinator-docs",
    "apinator://docs/llms.txt",
    {
      title: "Apinator documentation index",
      description: `The Apinator docs index for LLMs, fetched live from ${LLMS_TXT_URL}.`,
      mimeType: "text/markdown",
    },
    async (uri) => {
      if (!cached || now() - cached.at > DOCS_CACHE_MS) {
        try {
          const res = await fetchImpl(LLMS_TXT_URL, { signal: AbortSignal.timeout(DOCS_FETCH_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          cached = { text: await res.text(), at: now() };
        } catch (error) {
          if (!cached) {
            const reason = error instanceof Error ? error.message : String(error);
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: "text/markdown",
                  text: `<!-- Could not fetch ${LLMS_TXT_URL} (${reason}); showing the bundled protocol reference instead. -->\n\n${PROTOCOL_REFERENCE}`,
                },
              ],
            };
          }
          // Serve the stale copy rather than nothing.
        }
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: cached!.text }] };
    }
  );

  server.registerResource(
    "apinator-protocol",
    "apinator://reference/protocol",
    {
      title: "Apinator protocol and channel types",
      description: "WebSocket frames, system events, error codes, channel prefixes and the channel auth signature.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: PROTOCOL_REFERENCE }] })
  );
}

/** Registers the `add-realtime-feature` prompt. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "add-realtime-feature",
    {
      title: "Add a realtime feature",
      description: "Plan and build a realtime feature (live updates, chat, presence, notifications) with Apinator.",
      argsSchema: {
        feature: z.string().describe('What should update in realtime, e.g. "live order status on the dashboard".'),
        stack: z.string().optional().describe('Frontend and backend, e.g. "Next.js + Node" or "React + Django".'),
      },
    },
    ({ feature, stack }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Add this realtime feature to my app using Apinator: ${feature}
${stack ? `\nStack: ${stack}\n` : ""}
Work in this order:
1. Read the apinator://reference/protocol resource (and apinator://docs/llms.txt for SDK guides).
2. Look at the codebase and pick channel names and event names. Use private- channels for per-user or
   per-tenant data, presence- when you need "who is online", cache- when late joiners need the latest state,
   and public channels only for data anyone may see.
3. Server side: install the server SDK for the backend language, publish events where the data changes, and,
   for private/presence channels, add an auth endpoint that checks the user may join and returns
   authenticateChannel(socket_id, channel_name[, channel_data]). Keep APINATOR_SECRET server-side only.
4. Client side: install @apinator/client (or the Swift SDK), connect with the app key and cluster, subscribe,
   bind the events, and unsubscribe/clean up when the view unmounts.
5. Verify: use watch_channel on the channel, then publish_event (or trigger the real code path) and confirm
   the event arrives with the payload shape the client expects. Use list_channels / get_channel to confirm
   the client is subscribed.
Tell me which channels and events you chose and why before writing a lot of code.`,
          },
        },
      ],
    })
  );
}
