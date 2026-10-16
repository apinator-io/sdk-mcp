import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Apinator } from "@apinator/server";
import { createApinator } from "./client";
import type { Config } from "./config";
import { registerPrompts, registerResources } from "./resources";
import { registerTools } from "./tools";
import { VERSION } from "./version";

export interface ServerOptions {
  /** Overrides the SDK client (tests). */
  client?: Apinator;
  /** Overrides fetch for the docs resource (tests). */
  fetchImpl?: typeof fetch;
}

/** Builds the Apinator MCP server for `config`. Connect it to a transport to serve it. */
export function createServer(config: Config, options: ServerOptions = {}): McpServer {
  const client = options.client ?? createApinator(config);
  const server = new McpServer(
    { name: "apinator", title: "Apinator", version: VERSION },
    {
      instructions:
        `Tools for the Apinator realtime app ${config.appId} (cluster ${config.cluster}). ` +
        "Channels only show up in list_channels/get_channel while a client is subscribed. " +
        "To test delivery end to end, start watch_channel and publish while it is listening; " +
        "on cache- channels a watch started after a publish also receives the last event. " +
        "Read apinator://reference/protocol for channel types and frames." +
        (config.readOnly ? " This server is in read-only mode: publish_event is disabled." : ""),
    }
  );
  registerTools(server, { config, client });
  registerResources(server, { fetchImpl: options.fetchImpl });
  registerPrompts(server);
  return server;
}
