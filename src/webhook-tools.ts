import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config";
import { ToolError } from "./errors";
import { toolRunner } from "./tools";
import { MAX_WEBHOOKS_PER_APP, WEBHOOK_EVENTS, WebhookApi, withoutSecret } from "./webhooks";

const webhookId = z.string().uuid("Webhook ids are UUIDs; call list_webhooks for them.").describe("Webhook id, from list_webhooks or add_webhook.");

const webhookUrl = z
  .string()
  .url()
  .max(2048)
  .regex(/^https?:\/\//i, "Webhook URLs must start with http:// or https://.")
  .describe(
    "Receiver URL, e.g. https://myapp.example.com/api/apinator-webhook. It must be reachable from the internet: " +
      "private and loopback addresses (localhost, 10.x, 192.168.x) are refused. For a dev server on this machine, " +
      "expose it with a tunnel (cloudflared, ngrok) and use the tunnel URL."
  );

const eventList = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .describe(
    "Events to send: channel_occupied / channel_vacated (a channel got its first subscriber / lost its last), " +
      "member_added / member_removed (presence channels; the body carries user_id)."
  );

const DELIVERY_STATUSES = ["pending", "delivering", "delivered", "failed"] as const;

/**
 * Registers the webhook management tools. In read-only mode only the listing
 * tools are registered: nothing that creates, changes, deletes or sends.
 */
export function registerWebhookTools(server: McpServer, deps: { config: Config; webhooks?: WebhookApi }): void {
  const { config } = deps;
  const webhooks = deps.webhooks ?? new WebhookApi(config);
  const run = toolRunner(config);

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      description:
        `List the app's webhook endpoints (at most ${MAX_WEBHOOKS_PER_APP} per app): id, URL, events and whether each is enabled. ` +
        "Signing secrets are never listed; add_webhook shows a new endpoint's secret once.",
      inputSchema: {},
      annotations: { title: "List webhooks", readOnlyHint: true, openWorldHint: true },
    },
    run(async () => {
      const items = (await webhooks.list()).map(withoutSecret);
      return { count: items.length, max: MAX_WEBHOOKS_PER_APP, webhooks: items };
    })
  );

  server.registerTool(
    "list_webhook_deliveries",
    {
      title: "List webhook deliveries",
      description:
        "Recent deliveries to one webhook endpoint, newest first: event, payload, status, attempts and the last error. " +
        "Use it to check that events reach your receiver, or why they fail. Failed deliveries are retried 7 times " +
        "over about 9 hours; delivered and failed ones are kept 7 days.",
      inputSchema: {
        webhook_id: webhookId,
        status: z.enum(DELIVERY_STATUSES).optional().describe("Only deliveries in this state."),
        limit: z.number().int().min(1).max(100).default(20).describe("How many to return (default 20, max 100)."),
      },
      annotations: { title: "List webhook deliveries", readOnlyHint: true, openWorldHint: true },
    },
    run(async (args) => {
      const items = await webhooks.deliveries(args.webhook_id, { status: args.status, limit: args.limit });
      return { webhook_id: args.webhook_id, count: items.length, deliveries: items };
    })
  );

  if (config.readOnly) return;

  server.registerTool(
    "add_webhook",
    {
      title: "Add webhook",
      description:
        "Register a webhook endpoint that receives signed POSTs for the chosen events. Returns the endpoint and its " +
        "whsec_ signing secret, shown only this once: put it in the receiving app's environment (e.g. " +
        "APINATOR_WEBHOOK_SECRET) and verify each request with verifyWebhook from the server SDK. " +
        `An app can have at most ${MAX_WEBHOOKS_PER_APP} endpoints; adding a URL that is already registered is refused ` +
        "(use edit_webhook instead).",
      inputSchema: { url: webhookUrl, events: eventList },
      annotations: {
        title: "Add webhook",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run(async (args) => {
      const events = [...new Set(args.events)];
      const existing = await webhooks.list();
      const same = existing.find((hook) => hook.url === args.url);
      if (same) {
        throw new ToolError(
          `${args.url} is already registered as webhook ${same.id} (events: ${same.events.join(", ")}). ` +
            "Use edit_webhook to change it, or delete_webhook first if you need a new secret."
        );
      }
      if (existing.length >= MAX_WEBHOOKS_PER_APP) {
        throw new ToolError(
          `This app already has ${existing.length} webhook endpoints, the maximum. Remove one with delete_webhook first.`
        );
      }
      const created = await webhooks.create(args.url, events);
      if (!created.secret) {
        throw new ToolError(`Webhook ${created.id} was created, but the response carried no signing secret.`);
      }
      return {
        webhook: withoutSecret(created),
        secret: created.secret,
        secret_note:
          "This secret is not shown again. Store it now in the receiving app's environment (e.g. APINATOR_WEBHOOK_SECRET), " +
          "never in source control. If it is lost, delete the endpoint and add it again, or rotate it in the console.",
        verify:
          "Each request carries X-Realtime-Signature: sha256=hex(hmac_sha256(secret, \"{X-Realtime-Timestamp}.{raw body}\")). " +
          "Verify it on the raw body with verifyWebhook from the server SDK, then call test_webhook to check the receiver.",
      };
    })
  );

  server.registerTool(
    "edit_webhook",
    {
      title: "Edit webhook",
      description:
        "Change a webhook endpoint's URL, events, or enabled state. Pass only what changes. The signing secret stays the same.",
      inputSchema: {
        webhook_id: webhookId,
        url: webhookUrl.optional(),
        events: eventList.optional().describe("Replaces the event list."),
        enabled: z.boolean().optional().describe("false pauses deliveries without deleting the endpoint."),
      },
      annotations: {
        title: "Edit webhook",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    run(async (args) => {
      if (args.url === undefined && args.events === undefined && args.enabled === undefined) {
        throw new ToolError("Pass at least one of `url`, `events` or `enabled`.");
      }
      const updated = await webhooks.update(args.webhook_id, {
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.events !== undefined ? { events: [...new Set(args.events)] } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
      });
      return { webhook: withoutSecret(updated) };
    })
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete webhook",
      description: "Delete a webhook endpoint. It stops receiving events at once, and its pending deliveries are dropped.",
      inputSchema: { webhook_id: webhookId },
      annotations: {
        title: "Delete webhook",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    run(async (args) => {
      await webhooks.remove(args.webhook_id);
      return { deleted: true, webhook_id: args.webhook_id };
    })
  );

  server.registerTool(
    "test_webhook",
    {
      title: "Test webhook",
      description:
        "Send one signed webhook.test event to an endpoint now and report the receiver's HTTP status and timing. " +
        "Redirects are not followed. The test event is not queued or retried, and real events never use this type.",
      inputSchema: { webhook_id: webhookId },
      annotations: {
        title: "Test webhook",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    run(async (args) => {
      const result = await webhooks.test(args.webhook_id);
      if (result.success) return { webhook_id: args.webhook_id, ...result };
      const hint =
        result.status_code === 0
          ? "The receiver could not be reached; check the URL is public and the server is running."
          : result.status_code === 401 || result.status_code === 403
            ? "The receiver refused it: usually a signature check using the wrong secret, or one computed on a re-serialised body instead of the raw bytes."
            : "The receiver answered with a non-2xx status; it must return 2xx to acknowledge a delivery.";
      return { webhook_id: args.webhook_id, ...result, hint };
    })
  );
}
