import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type Apinator } from "@apinator/server";
import { z } from "zod";
import type { Config } from "./config";
import { describeError, redact, ToolError } from "./errors";
import { MAX_KEPT_EVENTS, MAX_WATCH_SECONDS, watchChannel } from "./watch";

/** Largest fan-out the publish API accepts in one call. */
export const MAX_PUBLISH_CHANNELS = 100;

const channelName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S+$/, "Channel names cannot contain whitespace.");

const socketId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S+$/, "Socket ids cannot contain whitespace.")
  .describe('Socket id of a connected client, from realtime:connection_established (e.g. "node-eu-1.42").');

const jsonPayload = z.union([z.string(), z.record(z.string(), z.unknown())]);

interface Deps {
  config: Config;
  client: Apinator;
}

/** Registers every Apinator tool on `server`. `publish_event` is skipped in read-only mode. */
export function registerTools(server: McpServer, deps: Deps): void {
  const { config, client } = deps;
  const ok = (value: unknown): CallToolResult => ({
    content: [{ type: "text", text: redact(JSON.stringify(value, null, 2), config.secret) }],
  });
  const fail = (error: unknown): CallToolResult => ({
    isError: true,
    content: [{ type: "text", text: describeError(error, config.secret) }],
  });
  const run =
    <A>(fn: (args: A, extra: { signal: AbortSignal }) => Promise<unknown>) =>
    async (args: A, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      try {
        return ok(await fn(args, extra));
      } catch (error) {
        return fail(error);
      }
    };

  if (!config.readOnly) {
    server.registerTool(
      "publish_event",
      {
        title: "Publish event",
        description:
          "Publish an event to one or more Apinator channels. Every client subscribed to those channels " +
          "receives it immediately. On cache- channels the event is also stored and replayed to future subscribers. " +
          "Pass exactly one of `channel` or `channels`.",
        inputSchema: {
          channel: channelName.optional().describe("Channel to publish to, e.g. \"orders\" or \"private-user-42\"."),
          channels: z
            .array(channelName)
            .min(1)
            .max(MAX_PUBLISH_CHANNELS)
            .optional()
            .describe(`Several channels to publish the same event to (max ${MAX_PUBLISH_CHANNELS}).`),
          name: z
            .string()
            .min(1)
            .max(200)
            .describe('Event name, e.g. "order-created". Names starting with "realtime:" are reserved.'),
          data: jsonPayload.describe(
            "Event payload. An object is sent as JSON; a string is sent as-is (clients JSON-decode it if they can)."
          ),
          socket_id: socketId.optional().describe("Exclude this connection from receiving the event (the sender's own socket)."),
        },
        annotations: {
          title: "Publish event",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      run(async (args) => {
        if (args.channel && args.channels) throw new ToolError("Pass either `channel` or `channels`, not both.");
        if (!args.channel && !args.channels) throw new ToolError("Pass `channel` or `channels`.");
        if (args.name.startsWith("realtime:")) {
          throw new ToolError('Event names starting with "realtime:" are reserved for the protocol. Use a name like "order-created".');
        }
        const data = typeof args.data === "string" ? args.data : JSON.stringify(args.data);
        if (data === "") throw new ToolError("`data` cannot be empty. Send an object, or a non-empty string.");
        const channels = args.channels ?? [args.channel as string];
        await client.trigger({
          name: args.name,
          data,
          ...(args.channels ? { channels: args.channels } : { channel: args.channel }),
          ...(args.socket_id ? { socketId: args.socket_id } : {}),
        });
        return { published: true, name: args.name, channels, bytes: Buffer.byteLength(data) };
      })
    );
  }

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description:
        "List the app's active channels (channels with at least one subscriber right now) and their subscriber counts. " +
        "Channels that nobody is subscribed to are not listed, even if events were published to them.",
      inputSchema: {
        prefix: z
          .string()
          .max(200)
          .optional()
          .describe('Only return channels whose name starts with this, e.g. "presence-" or "private-".'),
      },
      annotations: { title: "List channels", readOnlyHint: true, openWorldHint: true },
    },
    run(async (args) => {
      // The API encodes an empty list as `"channels": null`.
      const channels = (await client.getChannels(args.prefix || undefined)) ?? [];
      return { count: channels.length, ...(args.prefix ? { prefix: args.prefix } : {}), channels };
    })
  );

  server.registerTool(
    "get_channel",
    {
      title: "Get channel",
      description: "Get one channel's subscriber count. Reports `active: false` when nobody is subscribed to it.",
      inputSchema: { channel: channelName.describe("Channel name.") },
      annotations: { title: "Get channel", readOnlyHint: true, openWorldHint: true },
    },
    run(async (args) => {
      try {
        const info = await client.getChannel(args.channel);
        return { active: true, ...info };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return {
            name: args.channel,
            active: false,
            subscription_count: 0,
            message: `Channel "${args.channel}" is not active: no client is subscribed to it right now. Channels exist only while they have subscribers.`,
          };
        }
        throw error;
      }
    })
  );

  server.registerTool(
    "sign_channel_auth",
    {
      title: "Sign channel auth",
      description:
        "Compute the auth signature a client needs to subscribe to a private- or presence- channel, exactly as your " +
        "auth endpoint would return it. Useful for testing an auth flow or debugging a signature mismatch. " +
        "Presence channels need `channel_data` with a user_id.",
      inputSchema: {
        socket_id: socketId,
        channel: channelName.describe('A "private-" or "presence-" channel.'),
        channel_data: jsonPayload
          .optional()
          .describe('Presence member data, e.g. {"user_id":"42","user_info":{"name":"Ada"}}. Required for presence channels.'),
      },
      annotations: { title: "Sign channel auth", readOnlyHint: true, openWorldHint: false },
    },
    run(async (args) => {
      const isPresence = args.channel.startsWith("presence-");
      if (!isPresence && !args.channel.startsWith("private-")) {
        throw new ToolError(`"${args.channel}" is a public channel; only private- and presence- channels need auth.`);
      }
      const channelData = args.channel_data === undefined ? undefined : presenceData(args.channel_data);
      if (isPresence && channelData === undefined) {
        throw new ToolError('Presence channels need `channel_data` with a user_id, e.g. {"user_id":"42"}.');
      }
      if (!isPresence && channelData !== undefined) {
        throw new ToolError("`channel_data` only applies to presence- channels.");
      }
      return client.authenticateChannel(args.socket_id, args.channel, channelData);
    })
  );

  server.registerTool(
    "watch_channel",
    {
      title: "Watch channel",
      description:
        "Subscribe to a channel over WebSocket and collect the events that arrive for a few seconds, then disconnect. " +
        "Use it to confirm events are flowing, see payload shapes, or test a publish end to end (start the watch, " +
        "then publish). Private and presence channels are signed automatically. On presence channels the watcher " +
        "joins as a member, which other subscribers will see.",
      inputSchema: {
        channel: channelName.describe("Channel to subscribe to."),
        seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WATCH_SECONDS)
          .default(10)
          .describe(`How long to listen after subscribing (default 10, max ${MAX_WATCH_SECONDS}).`),
        max_events: z
          .number()
          .int()
          .min(1)
          .max(MAX_KEPT_EVENTS)
          .default(50)
          .describe(`How many events to keep; later ones are counted but dropped (default 50, max ${MAX_KEPT_EVENTS}).`),
        until_events: z
          .number()
          .int()
          .min(1)
          .max(MAX_KEPT_EVENTS)
          .optional()
          .describe("Stop early once this many events have arrived."),
        channel_data: jsonPayload
          .optional()
          .describe("Presence member data to join with. Defaults to a watcher identity."),
      },
      annotations: { title: "Watch channel", readOnlyHint: true, openWorldHint: true },
    },
    run(async (args, extra) => {
      if (args.channel_data !== undefined && !args.channel.startsWith("presence-")) {
        throw new ToolError("`channel_data` only applies to presence- channels.");
      }
      return watchChannel({
        config,
        client,
        channel: args.channel,
        seconds: args.seconds,
        maxEvents: args.max_events,
        untilEvents: args.until_events,
        channelData: args.channel_data === undefined ? undefined : presenceData(args.channel_data),
        signal: extra.signal,
      });
    })
  );
}

/** Normalises presence channel_data to the JSON string the signature covers, checking it has a user_id. */
function presenceData(value: string | Record<string, unknown>): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ToolError("`channel_data` must be JSON, e.g. {\"user_id\":\"42\"}.");
    }
  }
  const userId = (parsed as { user_id?: unknown } | null)?.user_id;
  // The server decodes user_id as a string; a number would be rejected as invalid channel_data.
  if (typeof parsed !== "object" || parsed === null || typeof userId !== "string" || userId === "") {
    throw new ToolError('`channel_data` must be an object with a non-empty string user_id, e.g. {"user_id":"42"}.');
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
