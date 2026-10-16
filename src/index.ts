/**
 * @apinator/mcp — Model Context Protocol server for Apinator.
 *
 * Most people run it with `npx -y @apinator/mcp`. These exports are for
 * embedding the server in another process or transport.
 *
 * @packageDocumentation
 */

export { createServer, type ServerOptions } from "./server";
export { loadConfig, ConfigError, type Config } from "./config";
export { watchChannel, type WatchOptions, type WatchResult, type WatchedEvent } from "./watch";
export { VERSION } from "./version";
