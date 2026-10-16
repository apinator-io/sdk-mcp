import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApinator } from "../src/client";
import { PROTOCOL_REFERENCE } from "../src/resources";
import { connect, jsonResponse, makeConfig, SECRET, sign } from "./helpers";

type FetchMock = ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastRequest() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
    rawBody: (init?.body as string | undefined) ?? "",
  };
}

describe("tool registration", () => {
  it("lists all five tools with the right annotations", async () => {
    const mcp = await connect(makeConfig());
    const { tools } = await mcp.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ["get_channel", "list_channels", "publish_event", "sign_channel_auth", "watch_channel"].sort()
    );
    expect(byName.publish_event.annotations?.readOnlyHint).toBe(false);
    expect(byName.publish_event.annotations?.destructiveHint).toBe(false);
    for (const name of ["get_channel", "list_channels", "sign_channel_auth", "watch_channel"]) {
      expect(byName[name].annotations?.readOnlyHint).toBe(true);
    }
    await mcp.close();
  });

  it("does not register publish_event in read-only mode", async () => {
    const mcp = await connect(makeConfig({ readOnly: true }));
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("publish_event");
    expect(mcp.client.getInstructions()).toMatch(/read-only/);
    const result = await mcp.call("publish_event", { channel: "a", name: "b", data: "c" });
    expect(result.isError).toBe(true);
    await mcp.close();
  });
});

describe("publish_event", () => {
  it("signs and posts a single-channel event with object data", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("publish_event", { channel: "orders", name: "order-created", data: { id: 1 } });

    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ published: true, name: "order-created", channels: ["orders"] });
    const req = lastRequest();
    expect(req.url).toBe("https://ws-eu.apinator.io/apps/app-123/events");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ name: "order-created", channel: "orders", data: '{"id":1}' });
    const ts = req.headers["X-Realtime-Timestamp"];
    const md5 = createHash("md5").update(req.rawBody).digest("hex");
    expect(req.headers["X-Realtime-Key"]).toBe("key-abc");
    expect(req.headers["X-Realtime-Signature"]).toBe(sign(SECRET, `${ts}\nPOST\n/apps/app-123/events\n${md5}`));
    await mcp.close();
  });

  it("sends string data unchanged, multiple channels and socket_id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("publish_event", {
      channels: ["a", "b"],
      name: "ping",
      data: "hello",
      socket_id: "node-eu-1.7",
    });
    expect(result.isError).toBe(false);
    expect(lastRequest().body).toEqual({ name: "ping", channels: ["a", "b"], data: "hello", socket_id: "node-eu-1.7" });
    await mcp.close();
  });

  it.each([
    [{ channel: "a", name: "realtime:subscribe", data: "x" }, /reserved/],
    [{ channel: "a", channels: ["b"], name: "e", data: "x" }, /not both/],
    [{ name: "e", data: "x" }, /Pass `channel` or `channels`/],
    [{ channel: "a", name: "e", data: "" }, /cannot be empty/],
  ])("rejects %j without calling the API", async (args, message) => {
    const mcp = await connect(makeConfig());
    const result = await mcp.call("publish_event", args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    expect(fetchMock).not.toHaveBeenCalled();
    await mcp.close();
  });

  it("rejects more than 100 channels", async () => {
    const mcp = await connect(makeConfig());
    const channels = Array.from({ length: 101 }, (_, i) => `c${i}`);
    const result = await mcp.call("publish_event", { channels, name: "e", data: "x" });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await mcp.close();
  });

  it("returns a clean auth error that never contains the secret", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { title: "Unauthorized", detail: `bad signature for secret ${SECRET}`, status: 401 })
    );
    const mcp = await connect(makeConfig());
    const result = await mcp.call("publish_event", { channel: "a", name: "e", data: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/rejected the credentials/);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain("[redacted]");
    await mcp.close();
  });

  it("shortens long non-JSON error bodies", async () => {
    fetchMock.mockResolvedValue(new Response(`<html>${"x".repeat(5000)}</html>`, { status: 502 }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("publish_event", { channel: "a", name: "e", data: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/HTTP 502/);
    expect(result.text.length).toBeLessThan(600);
    await mcp.close();
  });

  it("explains network failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND ws-xx.apinator.io") }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("publish_event", { channel: "a", name: "e", data: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Network error/);
    await mcp.close();
  });
});

describe("list_channels", () => {
  it("lists channels, passing the prefix as filter_by_prefix", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { channels: [{ name: "presence-room", subscription_count: 2 }] }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("list_channels", { prefix: "presence-" });
    expect(result.json).toEqual({
      count: 1,
      prefix: "presence-",
      channels: [{ name: "presence-room", subscription_count: 2 }],
    });
    const req = lastRequest();
    expect(req.url).toBe("https://ws-eu.apinator.io/apps/app-123/channels?filter_by_prefix=presence-");
    expect(req.method).toBe("GET");
    // Signature covers the path only, without the query string.
    const ts = req.headers["X-Realtime-Timestamp"];
    expect(req.headers["X-Realtime-Signature"]).toBe(sign(SECRET, `${ts}\nGET\n/apps/app-123/channels\n`));
    await mcp.close();
  });

  it("lists all channels without a prefix, treating null as empty", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { channels: null }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("list_channels");
    expect(result.json).toEqual({ count: 0, channels: [] });
    expect(lastRequest().url).toBe("https://ws-eu.apinator.io/apps/app-123/channels");
    await mcp.close();
  });
});

describe("get_channel", () => {
  it("returns an active channel", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { name: "private-chat", subscription_count: 3 }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("get_channel", { channel: "private-chat" });
    expect(result.json).toEqual({ active: true, name: "private-chat", subscription_count: 3 });
    expect(lastRequest().url).toBe("https://ws-eu.apinator.io/apps/app-123/channels/private-chat");
    await mcp.close();
  });

  it("reports an inactive channel clearly instead of an error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { title: "Not Found", detail: "channel not found", status: 404 }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("get_channel", { channel: "orders" });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ name: "orders", active: false, subscription_count: 0 });
    expect(result.json.message).toMatch(/not active/);
    await mcp.close();
  });

  it("surfaces other errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { detail: "slow down" }));
    const mcp = await connect(makeConfig());
    const result = await mcp.call("get_channel", { channel: "orders" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Rate limited/);
    await mcp.close();
  });
});

describe("sign_channel_auth", () => {
  it("signs a private channel", async () => {
    const mcp = await connect(makeConfig());
    const result = await mcp.call("sign_channel_auth", { socket_id: "node-eu-1.5", channel: "private-chat" });
    expect(result.json).toEqual({ auth: `key-abc:${sign(SECRET, "node-eu-1.5:private-chat")}` });
    expect(result.text).not.toContain(SECRET);
    await mcp.close();
  });

  it("signs a presence channel with object channel_data", async () => {
    const mcp = await connect(makeConfig());
    const channelData = { user_id: "42", user_info: { name: "Ada" } };
    const result = await mcp.call("sign_channel_auth", {
      socket_id: "node-eu-1.5",
      channel: "presence-room",
      channel_data: channelData,
    });
    const encoded = JSON.stringify(channelData);
    expect(result.json).toEqual({
      auth: `key-abc:${sign(SECRET, `node-eu-1.5:presence-room:${encoded}`)}`,
      channel_data: encoded,
    });
    await mcp.close();
  });

  it("keeps string channel_data byte-for-byte", async () => {
    const mcp = await connect(makeConfig());
    const encoded = '{ "user_id": "42" }';
    const result = await mcp.call("sign_channel_auth", {
      socket_id: "s.1",
      channel: "presence-room",
      channel_data: encoded,
    });
    expect(result.json).toEqual({ auth: `key-abc:${sign(SECRET, `s.1:presence-room:${encoded}`)}`, channel_data: encoded });
    await mcp.close();
  });

  it.each([
    [{ socket_id: "s.1", channel: "public" }, /public channel/],
    [{ socket_id: "s.1", channel: "presence-room" }, /need `channel_data`/],
    [{ socket_id: "s.1", channel: "presence-room", channel_data: { user_id: 42 } }, /string user_id/],
    [{ socket_id: "s.1", channel: "presence-room", channel_data: "not json" }, /must be JSON/],
    [{ socket_id: "s.1", channel: "private-a", channel_data: { user_id: "1" } }, /only applies to presence/],
  ])("rejects %j", async (args, message) => {
    const mcp = await connect(makeConfig());
    const result = await mcp.call("sign_channel_auth", args);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
    await mcp.close();
  });
});

describe("resources and prompts", () => {
  it("serves llms.txt, cached between reads", async () => {
    const docsFetch = vi.fn(async () => new Response("# Apinator docs"));
    const mcp = await connect(makeConfig(), { fetchImpl: docsFetch as unknown as typeof fetch });
    const { resources } = await mcp.client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["apinator://docs/llms.txt", "apinator://reference/protocol"]);

    for (let i = 0; i < 2; i++) {
      const read = await mcp.client.readResource({ uri: "apinator://docs/llms.txt" });
      expect(read.contents[0]).toMatchObject({ text: "# Apinator docs", mimeType: "text/markdown" });
    }
    expect(docsFetch).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it("falls back to the bundled reference when llms.txt is unreachable", async () => {
    const docsFetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const mcp = await connect(makeConfig(), { fetchImpl: docsFetch as unknown as typeof fetch });
    const read = await mcp.client.readResource({ uri: "apinator://docs/llms.txt" });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toContain("offline");
    expect(text).toContain(PROTOCOL_REFERENCE);
    await mcp.close();
  });

  it("serves the protocol reference", async () => {
    const mcp = await connect(makeConfig());
    const read = await mcp.client.readResource({ uri: "apinator://reference/protocol" });
    expect((read.contents[0] as { text: string }).text).toContain("realtime:connection_established");
    await mcp.close();
  });

  it("offers the add-realtime-feature prompt", async () => {
    const mcp = await connect(makeConfig());
    const prompt = await mcp.client.getPrompt({
      name: "add-realtime-feature",
      arguments: { feature: "live order status", stack: "Next.js" },
    });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toContain("live order status");
    expect(text).toContain("Next.js");
    expect(text).toContain("watch_channel");
    await mcp.close();
  });
});

describe("createApinator", () => {
  it("points the SDK at APINATOR_API_URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { channels: [] }));
    await createApinator(makeConfig({ apiUrl: "http://localhost:18081" })).getChannels();
    expect(lastRequest().url).toBe("http://localhost:18081/apps/app-123/channels");
  });
});
