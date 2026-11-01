import { signRequest } from "@apinator/server";
import type { Config } from "./config";
import { ToolError } from "./errors";

/** Event types an endpoint can listen for. */
export const WEBHOOK_EVENTS = ["channel_occupied", "channel_vacated", "member_added", "member_removed"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

/** Endpoints one app can register (the control plane enforces it too). */
export const MAX_WEBHOOKS_PER_APP = 10;

/** One webhook endpoint. `secret` is only ever present on the create response. */
export interface Webhook {
  id: string;
  app_id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
  secret?: string;
}

export interface WebhookPatch {
  url?: string;
  events?: string[];
  enabled?: boolean;
}

export interface WebhookTestResult {
  success: boolean;
  status_code: number;
  duration_ms: number;
  error?: string;
}

export interface WebhookDelivery {
  id: string;
  event_type: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  last_attempt_at?: string;
  last_error?: string;
  next_retry_at: string;
  created_at: string;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Webhook management on the Apinator control plane, signed with the app key
 * exactly like a server SDK call to the data plane. The control plane only
 * accepts the key for its own app, and never returns an existing endpoint's
 * secret: only `create` does, once.
 */
export class WebhookApi {
  constructor(private readonly config: Config) {}

  async list(): Promise<Webhook[]> {
    const res = await this.request<{ items?: Webhook[] | null }>("GET", this.base());
    return res.items ?? [];
  }

  create(url: string, events: string[]): Promise<Webhook> {
    return this.request("POST", this.base(), { url, events });
  }

  update(id: string, patch: WebhookPatch): Promise<Webhook> {
    return this.request("PATCH", `${this.base()}/${id}`, patch, id);
  }

  async remove(id: string): Promise<void> {
    await this.request("DELETE", `${this.base()}/${id}`, undefined, id);
  }

  test(id: string): Promise<WebhookTestResult> {
    return this.request("POST", `${this.base()}/${id}/test`, undefined, id);
  }

  async deliveries(id: string, opts: { status?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
    const query = new URLSearchParams();
    if (opts.status) query.set("status", opts.status);
    if (opts.limit) query.set("limit", String(opts.limit));
    const qs = query.toString();
    const res = await this.request<{ items?: WebhookDelivery[] | null }>(
      "GET",
      `${this.base()}/${id}/deliveries`,
      undefined,
      id,
      qs
    );
    return res.items ?? [];
  }

  private base(): string {
    return `/api/v1/apps/${encodeURIComponent(this.config.appId)}/webhooks`;
  }

  private async request<T>(method: string, path: string, payload?: unknown, webhookId?: string, query = ""): Promise<T> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      "X-Realtime-Key": this.config.key,
      "X-Realtime-Timestamp": String(timestamp),
      // The control plane verifies the path without the query string.
      "X-Realtime-Signature": signRequest(this.config.secret, method, path, body, timestamp),
    };
    if (body !== "") headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(`${this.config.controlUrl}${path}${query ? `?${query}` : ""}`, {
        method,
        headers,
        body: body === "" ? undefined : body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as Error & { cause?: unknown }).cause;
      const detail = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
      throw new ToolError(`Could not reach the Apinator control plane at ${this.config.controlUrl} (${detail}).`);
    }

    const text = await response.text();
    if (response.ok) return (text === "" ? {} : JSON.parse(text)) as T;
    throw new ToolError(this.describeFailure(response.status, problemMessage(text), webhookId));
  }

  private describeFailure(status: number, message: string, webhookId?: string): string {
    if (status === 401) {
      if (/authorization header/i.test(message)) {
        // A control plane from before app-key auth: it only knows console sessions.
        return (
          `The Apinator control plane at ${this.config.controlUrl} does not accept app-key auth for webhooks ` +
          "(it asked for a console session). Manage webhooks in the console (https://console.apinator.io) instead."
        );
      }
      return (
        `Apinator rejected the credentials: ${message}. Check APINATOR_APP_ID, APINATOR_KEY and APINATOR_SECRET ` +
        "belong to the same app, and that the machine's clock is correct (requests are signed with a timestamp)."
      );
    }
    if (status === 404 && webhookId) {
      return `Webhook ${webhookId} was not found on this app. Call list_webhooks for the ids.`;
    }
    if (status === 404) return `Not found (HTTP 404): ${message}. Check APINATOR_APP_ID.`;
    if (status === 400) return `Apinator rejected the request: ${message}`;
    if (status === 422) return `Apinator refused the request: ${message}`;
    if (status === 429) return `Rate limited by Apinator (HTTP 429): ${message}. Wait a moment and retry.`;
    return `Apinator API error (HTTP ${status}): ${message}`;
  }
}

/** The one-line message from a problem+json body, or the raw text. */
function problemMessage(text: string): string {
  try {
    const problem = JSON.parse(text) as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === "string" && problem.detail) return problem.detail;
    if (typeof problem.title === "string" && problem.title) return problem.title;
  } catch {
    // not JSON
  }
  return text || "no details";
}

/** Drops `secret` from an endpoint, whatever the server sent. */
export function withoutSecret(hook: Webhook): Omit<Webhook, "secret"> {
  const { secret: _secret, ...rest } = hook;
  return rest;
}
