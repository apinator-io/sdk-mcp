import WebSocket from "ws";
import type { Apinator } from "@apinator/server";
import type { Config } from "./config";
import { ToolError } from "./errors";
import { VERSION } from "./version";

/** Longest a watch may collect events for. */
export const MAX_WATCH_SECONDS = 60;
/** Most events a single watch keeps; later ones are counted but dropped. */
export const MAX_KEPT_EVENTS = 200;
/** Event payloads longer than this are cut, so one big event can't flood the context. */
export const MAX_EVENT_DATA_CHARS = 8_000;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 5_000;

export interface WatchOptions {
  config: Config;
  client: Apinator;
  channel: string;
  /** How long to collect events after subscribing, in seconds. */
  seconds: number;
  /** How many events to keep (≤ MAX_KEPT_EVENTS). */
  maxEvents: number;
  /** Stop as soon as this many events have arrived. */
  untilEvents?: number;
  /** Presence member data (JSON string) to subscribe with. */
  channelData?: string;
  /** Time allowed for connect + subscribe. */
  connectTimeoutMs?: number;
  /** Called every `progressIntervalMs` while watching, so long watches can report liveness. */
  onProgress?: (progress: WatchProgress) => void;
  /** How often `onProgress` is called (default 5000). */
  progressIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WatchProgress {
  /** Milliseconds since the subscription succeeded. */
  elapsed_ms: number;
  /** Total milliseconds the watch will run unless it stops early. */
  total_ms: number;
  events_received: number;
}

export interface WatchedEvent {
  event: string;
  channel: string;
  /** Parsed JSON when the payload is JSON, otherwise the raw string. */
  data: unknown;
  data_truncated?: true;
  received_at: string;
  /** Milliseconds after the subscription succeeded. */
  offset_ms: number;
}

export interface WatchResult {
  channel: string;
  socket_id: string;
  watched_ms: number;
  stopped: "time_elapsed" | "until_events_reached" | "connection_closed" | "cancelled";
  events_received: number;
  events_kept: number;
  events_dropped: number;
  events: WatchedEvent[];
  /** Members reported by subscription_succeeded on presence channels. */
  presence?: unknown;
  /** Non-fatal realtime:error messages received while watching. */
  errors?: unknown[];
  close?: { code: number; reason: string };
  notes: string[];
}

interface Envelope {
  event?: unknown;
  channel?: unknown;
  data?: unknown;
}

type Phase = "connecting" | "subscribing" | "watching" | "done";

/**
 * Connects to the Apinator WebSocket, subscribes to one channel (signing
 * private/presence auth locally) and collects what arrives on it.
 *
 * Connection and subscription failures reject with a {@link ToolError}.
 * Once subscribed, the watch always resolves with what it collected.
 */
export function watchChannel(opts: WatchOptions): Promise<WatchResult> {
  const { config, client, channel } = opts;
  const isPresence = channel.startsWith("presence-");
  const needsAuth = isPresence || channel.startsWith("private-");
  const notes: string[] = [];
  const events: WatchedEvent[] = [];
  const errors: unknown[] = [];
  let received = 0;
  let socketId = "";
  let presence: unknown;
  let subscribedAt = 0;
  let phase: Phase = "connecting";

  const url =
    `${config.wsUrl}/app/${encodeURIComponent(config.key)}` +
    `?protocol=7&client=mcp&version=${encodeURIComponent(VERSION)}`;

  return new Promise<WatchResult>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS });
    } catch (err) {
      reject(new ToolError(`Could not open a WebSocket to ${config.wsUrl}: ${(err as Error).message}`));
      return;
    }

    const connectTimer = setTimeout(() => {
      fail(
        phase === "connecting"
          ? `Timed out connecting to ${config.wsUrl} (no realtime:connection_established).`
          : `Timed out waiting for the subscription to "${channel}" to be confirmed.`
      );
    }, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;

    const onAbort = () => finish("cancelled");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(connectTimer);
      if (watchTimer) clearTimeout(watchTimer);
      if (progressTimer) clearInterval(progressTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      ws.removeAllListeners("message");
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "watch finished");
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }

    function fail(message: string) {
      if (phase === "done") return;
      if (phase === "watching") {
        // Already subscribed: report what was collected rather than discarding it.
        notes.push(message);
        finish("connection_closed");
        return;
      }
      phase = "done";
      cleanup();
      reject(new ToolError(message));
    }

    function finish(stopped: WatchResult["stopped"], close?: { code: number; reason: string }) {
      if (phase === "done") return;
      if (phase !== "watching") {
        fail(stopped === "cancelled" ? "Watch cancelled before the subscription succeeded." : "Connection closed before the subscription succeeded.");
        return;
      }
      phase = "done";
      cleanup();
      resolve({
        channel,
        socket_id: socketId,
        watched_ms: Date.now() - subscribedAt,
        stopped,
        events_received: received,
        events_kept: events.length,
        events_dropped: received - events.length,
        events,
        ...(presence !== undefined ? { presence } : {}),
        ...(errors.length > 0 ? { errors } : {}),
        ...(close ? { close } : {}),
        notes,
      });
    }

    function send(event: string, data: unknown, ch?: string) {
      ws.send(JSON.stringify({ event, ...(ch ? { channel: ch } : {}), data: JSON.stringify(data) }));
    }

    function subscribe() {
      const payload: Record<string, string> = { channel };
      if (needsAuth) {
        let channelData = opts.channelData;
        if (isPresence && channelData === undefined) {
          channelData = JSON.stringify({
            user_id: `apinator-mcp-${socketId}`,
            user_info: { name: "Apinator MCP watcher" },
          });
          notes.push(
            `Joined as presence member "apinator-mcp-${socketId}"; other subscribers saw realtime:member_added and will see realtime:member_removed.`
          );
        }
        const auth = client.authenticateChannel(socketId, channel, channelData);
        payload.auth = auth.auth;
        if (auth.channel_data !== undefined) payload.channel_data = auth.channel_data;
      }
      phase = "subscribing";
      send("realtime:subscribe", payload);
    }

    function startWatching(data: unknown) {
      phase = "watching";
      clearTimeout(connectTimer);
      subscribedAt = Date.now();
      if (isPresence) presence = data;
      watchTimer = setTimeout(() => finish("time_elapsed"), opts.seconds * 1000);
      if (opts.onProgress) {
        const onProgress = opts.onProgress;
        progressTimer = setInterval(() => {
          // A throwing callback must not escape the timer and crash the process.
          try {
            onProgress({ elapsed_ms: Date.now() - subscribedAt, total_ms: opts.seconds * 1000, events_received: received });
          } catch (err) {
            notes.push(`Progress callback failed: ${(err as Error).message}`);
            clearInterval(progressTimer);
          }
        }, opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
      }
    }

    function record(event: string, rawData: unknown) {
      received++;
      if (events.length < opts.maxEvents) events.push(describe(event, rawData));
      // Checked after counting, not after keeping: until_events may exceed max_events.
      if (opts.untilEvents !== undefined && received >= opts.untilEvents) {
        finish("until_events_reached");
      }
    }

    function describe(event: string, rawData: unknown): WatchedEvent {
      const entry: WatchedEvent = {
        event,
        channel,
        data: undefined,
        received_at: new Date().toISOString(),
        offset_ms: Date.now() - subscribedAt,
      };
      if (typeof rawData === "string" && rawData.length > MAX_EVENT_DATA_CHARS) {
        entry.data = rawData.slice(0, MAX_EVENT_DATA_CHARS);
        entry.data_truncated = true;
      } else {
        entry.data = parseMaybeJson(rawData);
      }
      return entry;
    }

    // Anything thrown in here would otherwise escape the EventEmitter and
    // crash the whole MCP server process.
    ws.on("message", (raw) => {
      try {
        handleMessage(raw.toString());
      } catch (err) {
        fail(`Error handling a frame from ${config.wsUrl}: ${(err as Error).message}`);
      }
    });

    function handleMessage(raw: string) {
      let msg: Envelope;
      try {
        msg = JSON.parse(raw) as Envelope;
      } catch {
        return;
      }
      if (typeof msg.event !== "string") return;
      const event = msg.event;
      const data = parseMaybeJson(msg.data);

      // Watches end well inside the server's 120s activity timeout, so no keepalive is needed.
      if (event === "realtime:ping" || event === "realtime:pong") return;

      if (event === "realtime:error") {
        const code = (data as { code?: unknown } | null)?.code;
        const message = (data as { message?: unknown } | null)?.message;
        if (typeof code === "number" && code >= 4000 && code < 4100) {
          const reason = typeof message === "string" ? message.trim().replace(/\.+$/, "") : "no reason given";
          fail(`Connection refused (code ${code}): ${reason}. Check APINATOR_KEY and APINATOR_CLUSTER.`);
          return;
        }
        if (phase === "watching") errors.push(data);
        return;
      }

      if (phase === "connecting") {
        if (event === "realtime:connection_established") {
          const id = (data as { socket_id?: unknown } | null)?.socket_id;
          if (typeof id !== "string" || id === "") {
            fail("Server sent realtime:connection_established without a socket_id.");
            return;
          }
          socketId = id;
          subscribe();
        }
        return;
      }

      if (phase === "subscribing") {
        // Some subscription errors are sent without a channel (e.g. malformed request).
        if (event === "realtime:subscription_error" && (msg.channel === channel || !msg.channel)) {
          const d = (data ?? {}) as { error?: unknown; status?: unknown };
          fail(
            `Subscription to "${channel}" was refused: ${typeof d.error === "string" ? d.error : "unknown error"}` +
              (typeof d.status === "number" ? ` (status ${d.status})` : "") +
              "."
          );
          return;
        }
        if (event === "realtime:subscription_succeeded" && msg.channel === channel) {
          startWatching(data);
        }
        return;
      }

      if (phase === "watching" && msg.channel === channel) {
        if (event === "realtime:subscription_succeeded") return;
        record(event, msg.data);
      }
    }

    ws.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      fail(`WebSocket error connecting to ${config.wsUrl}: ${code ? `${code} ` : ""}${err.message}`.trim());
    });

    ws.on("unexpected-response", (_req, res) => {
      fail(`WebSocket upgrade to ${config.wsUrl} failed with HTTP ${res.statusCode}.`);
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      if (phase === "watching") {
        notes.push(`The server closed the connection (code ${code}${reason ? `: ${reason}` : ""}).`);
        finish("connection_closed", { code, reason });
      } else {
        fail(`Connection closed before subscribing (code ${code}${reason ? `: ${reason}` : ""}).`);
      }
    });

    if (channel.startsWith("presence-cache-")) {
      notes.push(
        "presence-cache- channel: the last event is replayed right after subscribing, so the first event may be older than this watch. " +
          "These channels have known issues; prefer cache- or private-cache- for last-event replay."
      );
    } else if (/^(private-)?cache-/.test(channel)) {
      notes.push(
        "Cache channel: the server replays the last event (if one was published in the cache TTL) right after subscribing, so the first event may be older than this watch."
      );
    }
  });
}

/** JSON-decodes a string when it holds JSON; anything else is returned unchanged. */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
