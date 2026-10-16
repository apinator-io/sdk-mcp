/**
 * End-to-end test against a real local Apinator stack, driving the built CLI
 * over stdio exactly as an MCP client would.
 *
 *   ./scripts/local-stack.sh up && npm run build && npm run test:integration
 *
 * Skipped unless APINATOR_INTEGRATION=1. Reads credentials from
 * .local-stack/env (written by local-stack.sh), or from the file named by
 * APINATOR_ENV_FILE (e.g. a throwaway production app), then the environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

/** The fields of tool results these tests look at. */
interface Json {
  published?: boolean;
  active?: boolean;
  stopped?: string;
  events?: unknown[];
  channels?: unknown[];
  presence?: { presence?: { ids?: string[] } };
  auth?: string;
  [key: string]: unknown;
}
const enabled = process.env.APINATOR_INTEGRATION === "1";

function stackEnv(): Record<string, string> {
  const file = resolve(ROOT, process.env.APINATOR_ENV_FILE ?? ".local-stack/env");
  const env: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2];
    }
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("APINATOR_") && key !== "APINATOR_INTEGRATION" && key !== "APINATOR_ENV_FILE") env[key] = process.env[key]!;
  }
  return env;
}

describe.runIf(enabled)("integration", () => {
  let client: Client;
  let secret: string;
  let key: string;

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).not.toContain(secret);
    return { isError: result.isError === true, text, json: (result.isError ? undefined : JSON.parse(text)) as Json };
  }

  beforeAll(async () => {
    const env = stackEnv();
    secret = env.APINATOR_SECRET;
    key = env.APINATOR_KEY;
    if (!secret || !key) {
      throw new Error("No credentials; run ./scripts/local-stack.sh up or set APINATOR_ENV_FILE.");
    }
    client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(ROOT, "dist/cli.js")],
        env: { PATH: process.env.PATH ?? "", ...env },
        stderr: "ignore",
      })
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  it("publishes to a cache- channel and watch_channel receives the cached event", async () => {
    const channel = `cache-mcp-it-${Date.now()}`;
    const payload = { status: "shipped", at: new Date().toISOString() };

    const published = await call("publish_event", { channel, name: "order-status", data: payload });
    expect(published.isError).toBe(false);
    expect(published.json).toMatchObject({ published: true, channels: [channel] });

    // Nobody was subscribed when it was published: the event reaches the watcher only via the cache.
    const watched = await call("watch_channel", { channel, seconds: 5, until_events: 1 });
    expect(watched.isError).toBe(false);
    expect(watched.json.stopped).toBe("until_events_reached");
    expect(watched.json.events).toHaveLength(1);
    expect(watched.json.events?.[0]).toMatchObject({ event: "order-status", channel, data: payload });
  });

  it("sees a live publish on a private channel while watching, and lists the channel", async () => {
    const channel = `private-mcp-it-${Date.now()}`;
    const watching = call("watch_channel", { channel, seconds: 15, until_events: 1 });
    // Keep a failed assertion below from also surfacing as an unhandled rejection.
    watching.catch(() => {});

    // Wait until the watcher's subscription is visible to the REST API.
    let info: Json = {};
    for (let i = 0; i < 50 && !info.active; i++) {
      await new Promise((r) => setTimeout(r, 100));
      info = (await call("get_channel", { channel })).json;
    }
    expect(info).toMatchObject({ active: true, name: channel, subscription_count: 1 });

    const listed = await call("list_channels", { prefix: "private-mcp-it-" });
    expect(listed.json.channels).toEqual([{ name: channel, type: "private", subscription_count: 1 }]);

    expect((await call("publish_event", { channel, name: "ping", data: "hello" })).isError).toBe(false);
    const watched = (await watching).json;
    expect(watched.events?.[0]).toMatchObject({ event: "ping", data: "hello" });
  });

  it("reports an inactive channel without an error", async () => {
    const result = await call("get_channel", { channel: `nobody-here-${Date.now()}` });
    expect(result.isError).toBe(false);
    expect(result.json.active).toBe(false);
  });

  it("joins a presence channel and gets the member list", async () => {
    const result = await call("watch_channel", {
      channel: `presence-mcp-it-${Date.now()}`,
      seconds: 1,
      channel_data: { user_id: "it-user", user_info: { name: "IT" } },
    });
    expect(result.isError).toBe(false);
    expect(result.json.presence?.presence?.ids).toContain("it-user");
  });

  it("signs channel auth with the app key", async () => {
    const result = await call("sign_channel_auth", { socket_id: "node-1.1", channel: "private-x" });
    expect(result.json.auth?.startsWith(`${key}:`)).toBe(true);
    expect(result.json.auth?.slice(key.length + 1)).toMatch(/^[0-9a-f]{64}$/);
  });
});
