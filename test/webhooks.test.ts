import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, jsonResponse, makeConfig, SECRET, sign } from "./helpers";

const APP_ID = "3f2b8c1e-9d4a-4f6b-8e2a-1c5d7f9b0a3e";
const BASE = `/api/v1/apps/${APP_ID}/webhooks`;

interface Hook {
  id: string;
  app_id: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * An in-memory control plane: verifies the app-key signature the way the Go
 * middleware does, then serves the webhook routes. Secrets only leave on create.
 */
function fakeControlPlane() {
  const hooks: Hook[] = [];
  const seen: Seen[] = [];
  let override: ((req: Seen) => Response | undefined) | undefined;

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const req: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: (init?.body as string | undefined) ?? "",
    };
    seen.push(req);
    const forced = override?.(req);
    if (forced) return forced;

    const ts = req.headers["X-Realtime-Timestamp"];
    const md5 = req.body === "" ? "" : createHash("md5").update(req.body).digest("hex");
    if (
      req.headers["X-Realtime-Key"] !== "key-abc" ||
      req.headers["X-Realtime-Signature"] !== sign(SECRET, `${ts}\n${req.method}\n${url.pathname}\n${md5}`)
    ) {
      return jsonResponse(401, { detail: "invalid signature: check that the secret belongs to this key" });
    }

    const view = ({ secret: _s, ...rest }: Hook) => rest;
    const path = url.pathname;
    if (path === BASE && req.method === "GET") return jsonResponse(200, { items: hooks.map(view) });
    if (path === BASE && req.method === "POST") {
      const { url: target, events } = JSON.parse(req.body) as { url: string; events: string[] };
      if (target.includes("localhost")) {
        return jsonResponse(400, { detail: "webhook URL must not point to a private or loopback address" });
      }
      const now = new Date().toISOString();
      const hook: Hook = {
        id: randomUUID(),
        app_id: APP_ID,
        url: target,
        secret: `whsec_${"ab".repeat(32)}`,
        events,
        enabled: true,
        created_at: now,
        updated_at: now,
      };
      hooks.push(hook);
      return jsonResponse(201, hook);
    }
    const match = path.match(new RegExp(`^${BASE}/([^/]+)(/test|/deliveries)?$`));
    const hook = match && hooks.find((h) => h.id === match[1]);
    if (!hook) return jsonResponse(404, { detail: "webhook not found" });
    if (!match[2] && req.method === "PATCH") {
      Object.assign(hook, JSON.parse(req.body));
      return jsonResponse(200, view(hook));
    }
    if (!match[2] && req.method === "DELETE") {
      hooks.splice(hooks.indexOf(hook), 1);
      return new Response(null, { status: 204 });
    }
    if (match[2] === "/test") return jsonResponse(200, { success: false, status_code: 401, duration_ms: 12 });
    if (match[2] === "/deliveries") {
      return jsonResponse(200, {
        items: [{ id: randomUUID(), event_type: "member_added", payload: { user_id: "42" }, status: "failed", attempts: 7 }],
        next_cursor: null,
      });
    }
    return jsonResponse(405, { detail: "method not allowed" });
  };

  return {
    hooks,
    seen,
    handler,
    setOverride(fn: typeof override) {
      override = fn;
    },
  };
}

let cp: ReturnType<typeof fakeControlPlane>;

beforeEach(() => {
  cp = fakeControlPlane();
  vi.stubGlobal("fetch", vi.fn(cp.handler));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = (overrides = {}) => makeConfig({ appId: APP_ID, ...overrides });

describe("webhook tools", () => {
  it("adds, edits, lists, tests and deletes an endpoint against the control plane", async () => {
    const mcp = await connect(config());

    const added = await mcp.call("add_webhook", { url: "https://example.com/hook", events: ["member_added", "member_added"] });
    expect(added.isError, added.text).toBe(false);
    expect(added.json.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(added.json.secret_note).toMatch(/not shown again/);
    const hook = added.json.webhook as { id: string; events: string[]; secret?: string };
    expect(hook.events).toEqual(["member_added"]);
    expect(hook.secret).toBeUndefined();

    const create = cp.seen.find((r) => r.method === "POST")!;
    expect(create.url).toBe(`https://api.apinator.io${BASE}`);
    expect(JSON.parse(create.body)).toEqual({ url: "https://example.com/hook", events: ["member_added"] });

    const edited = await mcp.call("edit_webhook", { webhook_id: hook.id, events: ["channel_occupied"], enabled: false });
    expect(edited.isError, edited.text).toBe(false);
    expect(edited.json.webhook).toMatchObject({ id: hook.id, events: ["channel_occupied"], enabled: false });
    expect(JSON.parse(cp.seen.at(-1)!.body)).toEqual({ events: ["channel_occupied"], enabled: false });

    const listed = await mcp.call("list_webhooks");
    expect(listed.isError).toBe(false);
    expect(listed.json).toMatchObject({ count: 1, max: 10 });
    expect(listed.text).not.toContain("whsec_");

    const tested = await mcp.call("test_webhook", { webhook_id: hook.id });
    expect(tested.json).toMatchObject({ success: false, status_code: 401 });
    expect(tested.json.hint).toMatch(/wrong secret|raw bytes/);

    const deliveries = await mcp.call("list_webhook_deliveries", { webhook_id: hook.id, status: "failed", limit: 5 });
    expect(deliveries.json).toMatchObject({ count: 1 });
    expect(cp.seen.at(-1)!.url).toBe(`https://api.apinator.io${BASE}/${hook.id}/deliveries?status=failed&limit=5`);

    const deleted = await mcp.call("delete_webhook", { webhook_id: hook.id });
    expect(deleted.json).toEqual({ deleted: true, webhook_id: hook.id });
    expect(cp.hooks).toHaveLength(0);

    for (const text of [added, edited, listed, tested, deliveries, deleted].map((r) => r.text)) {
      expect(text).not.toContain(SECRET);
    }
    await mcp.close();
  });

  it("uses APINATOR_CONTROL_URL", async () => {
    const mcp = await connect(config({ controlUrl: "http://localhost:8080" }));
    await mcp.call("list_webhooks");
    expect(cp.seen[0].url).toBe(`http://localhost:8080${BASE}`);
    await mcp.close();
  });

  it("refuses a URL that is already registered, and the eleventh endpoint", async () => {
    const mcp = await connect(config());
    expect((await mcp.call("add_webhook", { url: "https://example.com/a", events: ["channel_occupied"] })).isError).toBe(false);
    const dup = await mcp.call("add_webhook", { url: "https://example.com/a", events: ["member_added"] });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/already registered.*edit_webhook/);

    for (let i = 1; i < 10; i++) {
      await mcp.call("add_webhook", { url: `https://example.com/${i}`, events: ["channel_occupied"] });
    }
    expect(cp.hooks).toHaveLength(10);
    const full = await mcp.call("add_webhook", { url: "https://example.com/11", events: ["channel_occupied"] });
    expect(full.isError).toBe(true);
    expect(full.text).toMatch(/maximum.*delete_webhook/);
    expect(cp.hooks).toHaveLength(10);
    await mcp.close();
  });

  it("passes the control plane's URL validation error through", async () => {
    const mcp = await connect(config());
    const result = await mcp.call("add_webhook", { url: "http://localhost:3000/hook", events: ["member_added"] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/private or loopback/);
    await mcp.close();
  });

  it("validates input before calling the API", async () => {
    const mcp = await connect(config());
    const bad = [
      ["add_webhook", { url: "ftp://example.com", events: ["member_added"] }],
      ["add_webhook", { url: "https://example.com", events: [] }],
      ["add_webhook", { url: "https://example.com", events: ["client_event"] }],
      ["edit_webhook", { webhook_id: "not-a-uuid", enabled: true }],
      ["edit_webhook", { webhook_id: randomUUID() }],
    ] as const;
    for (const [name, args] of bad) {
      const result = await mcp.call(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(cp.seen).toHaveLength(0);
    await mcp.close();
  });

  it("explains an unknown webhook id, bad credentials and an old control plane", async () => {
    const mcp = await connect(config());
    const missing = await mcp.call("delete_webhook", { webhook_id: randomUUID() });
    expect(missing.text).toMatch(/not found on this app.*list_webhooks/);

    cp.setOverride(() => jsonResponse(401, { detail: "missing authorization header" }));
    const old = await mcp.call("list_webhooks");
    expect(old.isError).toBe(true);
    expect(old.text).toMatch(/does not accept app-key auth/);

    cp.setOverride(() => jsonResponse(401, { detail: `invalid api key: ${SECRET}` }));
    const denied = await mcp.call("list_webhooks");
    expect(denied.text).toMatch(/APINATOR_KEY and APINATOR_SECRET/);
    expect(denied.text).not.toContain(SECRET);

    cp.setOverride(() => jsonResponse(401, { detail: "invalid api key. Check your app's API keys in the console." }));
    const hinted = await mcp.call("list_webhooks");
    expect(hinted.text).toContain("in the console. Check APINATOR_APP_ID");
    expect(hinted.text).not.toContain("..");

    cp.setOverride(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") });
    });
    const down = await mcp.call("list_webhooks");
    expect(down.text).toMatch(/Could not reach the Apinator control plane.*ECONNREFUSED/);
    await mcp.close();
  });

  it("registers only the listing tools in read-only mode", async () => {
    const mcp = await connect(config({ readOnly: true }));
    const names = (await mcp.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_webhooks");
    expect(names).toContain("list_webhook_deliveries");
    for (const name of ["add_webhook", "edit_webhook", "delete_webhook", "test_webhook"]) {
      expect(names).not.toContain(name);
    }
    expect((await mcp.call("add_webhook", { url: "https://example.com", events: ["member_added"] })).isError).toBe(true);
    expect(cp.seen).toHaveLength(0);
    await mcp.close();
  });

  it("annotates delete as destructive and the listings as read-only", async () => {
    const mcp = await connect(config());
    const byName = Object.fromEntries((await mcp.client.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.delete_webhook.annotations?.destructiveHint).toBe(true);
    expect(byName.list_webhooks.annotations?.readOnlyHint).toBe(true);
    expect(byName.list_webhook_deliveries.annotations?.readOnlyHint).toBe(true);
    for (const name of ["add_webhook", "edit_webhook", "test_webhook"]) {
      expect(byName[name].annotations?.readOnlyHint).toBe(false);
    }
    await mcp.close();
  });
});
