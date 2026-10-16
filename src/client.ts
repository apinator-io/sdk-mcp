import { Apinator } from "@apinator/server";
import type { Config } from "./config";

/**
 * Creates the server SDK client for `config`.
 *
 * @apinator/server always targets https://ws-{cluster}.apinator.io. When
 * APINATOR_API_URL points somewhere else (a local data plane), the private
 * `host` field is replaced; the SDK reads it on every request.
 */
export function createApinator(config: Config): Apinator {
  const client = new Apinator({
    appId: config.appId,
    key: config.key,
    secret: config.secret,
    cluster: config.cluster,
  });
  const target = client as unknown as { host?: unknown };
  if (typeof target.host !== "string") {
    throw new Error("Unsupported @apinator/server version: expected a string `host` field.");
  }
  target.host = config.apiUrl;
  return client;
}
