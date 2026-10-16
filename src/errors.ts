import { ApiError, AuthenticationError, ValidationError } from "@apinator/server";

const MAX_MESSAGE_LENGTH = 500;

/**
 * Removes every occurrence of `secret` from `text`. Every string that leaves a
 * tool goes through this, as a last line of defence.
 */
export function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

/** A user-facing failure whose message is already safe to return. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Turns anything thrown while calling Apinator into a short, actionable
 * message with no secret, stack trace or raw response dump.
 */
export function describeError(error: unknown, secret: string): string {
  return redact(truncate(rawDescription(error)), secret);
}

function rawDescription(error: unknown): string {
  if (error instanceof ToolError) return error.message;

  if (error instanceof AuthenticationError) {
    return (
      `Apinator rejected the credentials: ${error.message}. ` +
      "Check APINATOR_APP_ID, APINATOR_KEY, APINATOR_SECRET and APINATOR_CLUSTER " +
      "all belong to the same app, and that the machine's clock is correct (requests are signed with a timestamp)."
    );
  }
  if (error instanceof ValidationError) {
    return `Apinator rejected the request: ${error.message}`;
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return `Not found (HTTP 404): ${error.message}. Check APINATOR_APP_ID and APINATOR_CLUSTER.`;
    }
    if (error.status === 429) {
      return `Rate limited by Apinator (HTTP 429): ${error.message}. Wait a moment and retry.`;
    }
    return `Apinator API error (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof Error) {
    // The SDK wraps network failures as "Network error: fetch failed"; the
    // useful part is usually in the cause (ENOTFOUND, ECONNREFUSED, ...).
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error && cause.message && !error.message.includes(cause.message)
        ? ` (${cause.message})`
        : "";
    return `${error.message}${causeText}`;
  }
  return String(error);
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_MESSAGE_LENGTH ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH)}…` : oneLine;
}
