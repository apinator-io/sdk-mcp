import { createHmac } from "node:crypto";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../src/config";
import { createServer, type ServerOptions } from "../src/server";

export const SECRET = "test-secret-do-not-leak-5f2c";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    appId: "app-123",
    key: "key-abc",
    secret: SECRET,
    cluster: "eu",
    readOnly: false,
    apiUrl: "https://ws-eu.apinator.io",
    wsUrl: "wss://ws-eu.apinator.io",
    ...overrides,
  };
}

/** Starts the MCP server in-process and returns a connected client. */
export async function connect(config: Config, options: ServerOptions = {}) {
  const server = createServer(config, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: result.isError === true, text, json: json as Record<string, unknown> };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function sign(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

interface Frame {
  event: string;
  channel?: string;
  data: string;
}

export interface FakeServerOptions {
  /** Sent instead of connection_established. */
  onConnect?: (ws: WebSocket) => void;
  /** Called for each subscribe; return false to stop the default reply. */
  onSubscribe?: (ws: WebSocket, data: { channel: string; auth?: string; channel_data?: string }) => boolean | void;
  /** Last event per cache channel, replayed after subscription_succeeded. */
  cache?: Record<string, { event: string; data: string }>;
}

/**
 * A minimal Apinator data plane WebSocket: connection_established, subscribe
 * with auth verification, cache replay, and helpers to push events.
 */
export async function startFakeRealtime(config: Config, opts: FakeServerOptions = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const subscriptions: { channel: string; auth?: string; channel_data?: string }[] = [];
  const requests: string[] = [];
  let counter = 0;

  wss.on("connection", (ws, req) => {
    requests.push(req.url ?? "");
    sockets.push(ws);
    const socketId = `node-test-1.${++counter}`;
    const send = (frame: Frame) => ws.send(JSON.stringify(frame));

    if (opts.onConnect) {
      opts.onConnect(ws);
    } else {
      send({
        event: "realtime:connection_established",
        data: JSON.stringify({ socket_id: socketId, activity_timeout: 120 }),
      });
    }

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Frame;
      if (msg.event !== "realtime:subscribe") return;
      const data = JSON.parse(msg.data) as { channel: string; auth?: string; channel_data?: string };
      subscriptions.push(data);
      if (opts.onSubscribe?.(ws, data) === false) return;

      const ch = data.channel;
      if (ch.startsWith("private-") || ch.startsWith("presence-")) {
        const input = data.channel_data ? `${socketId}:${ch}:${data.channel_data}` : `${socketId}:${ch}`;
        if (data.auth !== `${config.key}:${sign(config.secret, input)}`) {
          send({
            event: "realtime:subscription_error",
            channel: ch,
            data: JSON.stringify({ type: "AuthError", error: "invalid auth signature", status: 401 }),
          });
          return;
        }
      }
      const succeeded = ch.startsWith("presence-")
        ? JSON.stringify({ presence: { count: 1, ids: ["u1"], hash: { u1: null } } })
        : "{}";
      send({ event: "realtime:subscription_succeeded", channel: ch, data: succeeded });
      const cached = opts.cache?.[ch];
      if (cached) send({ event: cached.event, channel: ch, data: cached.data });
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    subscriptions,
    requests,
    /** Sends a frame to every connected socket. */
    broadcast(frame: Frame) {
      for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    closeAll(code = 4200, reason = "server restart") {
      for (const ws of sockets) ws.close(code, reason);
    },
    async stop() {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Resolves once `predicate` is true, polling every 5ms. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
