import { afterEach, describe, expect, it } from "vitest";
import { createApinator } from "../src/client";
import { MAX_EVENT_DATA_CHARS, parseMaybeJson, watchChannel, type WatchOptions } from "../src/watch";
import { connect, makeConfig, SECRET, startFakeRealtime, waitFor } from "./helpers";

type Fake = Awaited<ReturnType<typeof startFakeRealtime>>;
let fake: Fake | undefined;

afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

async function setup(opts: Parameters<typeof startFakeRealtime>[1] = {}) {
  const base = makeConfig();
  fake = await startFakeRealtime(base, opts);
  const config = makeConfig({ wsUrl: fake.url });
  return { config, client: createApinator(config) };
}

function watch(ctx: { config: WatchOptions["config"]; client: WatchOptions["client"] }, opts: Partial<WatchOptions> & { channel: string }) {
  return watchChannel({ seconds: 1, maxEvents: 50, ...ctx, ...opts });
}

describe("watchChannel", () => {
  it("connects with the app key and collects events on the channel only", async () => {
    const ctx = await setup();
    const pending = watch(ctx, { channel: "orders", seconds: 1 });
    await waitFor(() => fake!.subscriptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    fake!.broadcast({ event: "order-created", channel: "orders", data: '{"id":1}' });
    fake!.broadcast({ event: "noise", channel: "other", data: "x" });
    fake!.broadcast({ event: "text", channel: "orders", data: "plain text" });
    const result = await pending;

    expect(fake!.requests[0]).toMatch(/^\/app\/key-abc\?protocol=7&client=mcp&version=/);
    expect(fake!.subscriptions[0]).toEqual({ channel: "orders" });
    expect(result.stopped).toBe("time_elapsed");
    expect(result.socket_id).toBe("node-test-1.1");
    expect(result.events.map((e) => [e.event, e.data])).toEqual([
      ["order-created", { id: 1 }],
      ["text", "plain text"],
    ]);
    expect(result.events_received).toBe(2);
    expect(result.watched_ms).toBeGreaterThanOrEqual(900);
  });

  it("receives the cached event on cache channels", async () => {
    const ctx = await setup({ cache: { "cache-status": { event: "status", data: '{"ok":true}' } } });
    const result = await watch(ctx, { channel: "cache-status", untilEvents: 1, seconds: 5 });
    expect(result.stopped).toBe("until_events_reached");
    expect(result.events[0]).toMatchObject({ event: "status", data: { ok: true } });
    expect(result.notes.join(" ")).toMatch(/Cache channel/);
  });

  it("signs private channels itself", async () => {
    const ctx = await setup();
    const result = await watch(ctx, { channel: "private-chat", seconds: 1 });
    expect(result.stopped).toBe("time_elapsed");
    expect(fake!.subscriptions[0].auth).toMatch(/^key-abc:[0-9a-f]{64}$/);
  });

  it("joins presence channels with a default identity and reports members", async () => {
    const ctx = await setup();
    const result = await watch(ctx, { channel: "presence-room", seconds: 1 });
    const sub = fake!.subscriptions[0];
    expect(JSON.parse(sub.channel_data!)).toEqual({
      user_id: "apinator-mcp-node-test-1.1",
      user_info: { name: "Apinator MCP watcher" },
    });
    expect(result.presence).toEqual({ presence: { count: 1, ids: ["u1"], hash: { u1: null } } });
    expect(result.notes.join(" ")).toMatch(/presence member/);
  });

  it("uses provided presence channel_data", async () => {
    const ctx = await setup();
    await watch(ctx, { channel: "presence-room", seconds: 1, channelData: '{"user_id":"ada"}' });
    expect(fake!.subscriptions[0].channel_data).toBe('{"user_id":"ada"}');
  });

  it("keeps at most maxEvents and counts the rest", async () => {
    const ctx = await setup();
    const pending = watch(ctx, { channel: "feed", seconds: 1, maxEvents: 3 });
    await waitFor(() => fake!.subscriptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 10; i++) fake!.broadcast({ event: "tick", channel: "feed", data: String(i) });
    const result = await pending;
    expect(result.events_kept).toBe(3);
    expect(result.events_received).toBe(10);
    expect(result.events_dropped).toBe(7);
  });

  it("truncates oversized payloads", async () => {
    const ctx = await setup();
    const pending = watch(ctx, { channel: "big", seconds: 5, untilEvents: 1 });
    await waitFor(() => fake!.subscriptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    fake!.broadcast({ event: "blob", channel: "big", data: "y".repeat(MAX_EVENT_DATA_CHARS + 100) });
    const result = await pending;
    expect(result.events[0].data_truncated).toBe(true);
    expect((result.events[0].data as string).length).toBe(MAX_EVENT_DATA_CHARS);
  });

  it("rejects with the server's reason when the subscription is refused", async () => {
    const ctx = await setup();
    // A client signing with the wrong secret gets subscription_error.
    const wrong = createApinator(makeConfig({ wsUrl: ctx.config.wsUrl, secret: "wrong" }));
    await expect(watch({ config: ctx.config, client: wrong }, { channel: "private-x" })).rejects.toThrow(
      /refused: invalid auth signature \(status 401\)/
    );
  });

  it("rejects on a fatal realtime:error", async () => {
    const ctx = await setup({
      onConnect: (ws) =>
        ws.send(JSON.stringify({ event: "realtime:error", data: JSON.stringify({ code: 4001, message: "App not found" }) })),
    });
    await expect(watch(ctx, { channel: "orders" })).rejects.toThrow(/Connection refused \(code 4001\): App not found/);
  });

  it("rejects when the server never says connection_established", async () => {
    const ctx = await setup({ onConnect: () => {} });
    await expect(watch(ctx, { channel: "orders", connectTimeoutMs: 100 })).rejects.toThrow(/Timed out connecting/);
  });

  it("rejects when nothing is listening", async () => {
    const ctx = await setup();
    const url = fake!.url;
    await fake!.stop();
    fake = undefined;
    const config = makeConfig({ wsUrl: url });
    await expect(watch({ config, client: createApinator(config) }, { channel: "orders" })).rejects.toThrow(
      /WebSocket error connecting.*ECONNREFUSED/
    );
  });

  it("returns what it collected when the server closes mid-watch", async () => {
    const ctx = await setup();
    const pending = watch(ctx, { channel: "orders", seconds: 10 });
    await waitFor(() => fake!.subscriptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    fake!.broadcast({ event: "e", channel: "orders", data: "1" });
    await new Promise((r) => setTimeout(r, 20));
    fake!.closeAll(4200, "server restart");
    const result = await pending;
    expect(result.stopped).toBe("connection_closed");
    expect(result.close).toEqual({ code: 4200, reason: "server restart" });
    expect(result.events).toHaveLength(1);
  });

  it("stops when cancelled", async () => {
    const ctx = await setup();
    const controller = new AbortController();
    const pending = watch(ctx, { channel: "orders", seconds: 30, signal: controller.signal });
    await waitFor(() => fake!.subscriptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect((await pending).stopped).toBe("cancelled");
  });

  it("records non-fatal errors while watching", async () => {
    const ctx = await setup();
    const pending = watch(ctx, { channel: "orders", seconds: 1 });
    await waitFor(() => fake!.subscriptions.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    fake!.broadcast({ event: "realtime:error", data: JSON.stringify({ code: 4301, message: "rate limited" }) });
    const result = await pending;
    expect(result.errors).toEqual([{ code: 4301, message: "rate limited" }]);
  });
});

describe("watch_channel tool", () => {
  it("returns events as JSON and never the secret", async () => {
    const base = makeConfig();
    fake = await startFakeRealtime(base, { cache: { "cache-x": { event: "last", data: '{"v":2}' } } });
    const mcp = await connect(makeConfig({ wsUrl: fake.url }));
    const result = await mcp.call("watch_channel", { channel: "cache-x", seconds: 2, until_events: 1 });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ channel: "cache-x", events_received: 1, events: [{ event: "last", data: { v: 2 } }] });
    expect(result.text).not.toContain(SECRET);
    await mcp.close();
  });

  it("validates seconds and channel_data", async () => {
    const mcp = await connect(makeConfig());
    expect((await mcp.call("watch_channel", { channel: "a", seconds: 61 })).isError).toBe(true);
    const r = await mcp.call("watch_channel", { channel: "orders", channel_data: { user_id: "1" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/only applies to presence/);
    await mcp.close();
  });

  it("reports connection failures as tool errors", async () => {
    const mcp = await connect(makeConfig({ wsUrl: "ws://127.0.0.1:1" }));
    const result = await mcp.call("watch_channel", { channel: "orders", seconds: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/WebSocket error/);
    await mcp.close();
  });
});

describe("parseMaybeJson", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ["[1,2]", [1, 2]],
    ['"quoted"', "quoted"],
    ["42", "42"],
    ["{broken", "{broken"],
    ["", ""],
    [undefined, undefined],
  ])("%j → %j", (input, expected) => {
    expect(parseMaybeJson(input)).toEqual(expected);
  });
});
