import { Apinator, type RealtimeOptions } from "@apinator/server";
import type { Config } from "./config";

/**
 * Creates the server SDK client for `config`, pointed at `config.apiUrl`.
 *
 * @apinator/server 2.1+ takes the base URL as the `host` option. Older 2.x
 * releases always target https://ws-{cluster}.apinator.io, so for them the
 * private `host` field is replaced after construction; the SDK reads it on
 * every request.
 */
export function createApinator(config: Config): Apinator {
  // `host` is typed from @apinator/server 2.1; older releases ignore it.
  const options: RealtimeOptions & { host?: string } = {
    appId: config.appId,
    key: config.key,
    secret: config.secret,
    cluster: config.cluster,
    host: config.apiUrl,
  };
  const client = new Apinator(options);
  const target = client as unknown as { host?: unknown };
  if (typeof target.host !== "string") {
    throw new Error("Unsupported @apinator/server version: expected a string `host` field.");
  }
  if (target.host !== config.apiUrl) target.host = config.apiUrl;
  return client;
}
