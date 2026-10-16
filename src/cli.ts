import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config";
import { createServer } from "./server";
import { VERSION } from "./version";

// stdout carries the MCP protocol, so everything human-readable goes to stderr.
async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `Apinator MCP server ${VERSION} running on stdio (app ${config.appId}, cluster ${config.cluster}${config.readOnly ? ", read-only" : ""}).\n`
  );

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  // Never print the secret, even from an unexpected crash.
  const secret = process.env.APINATOR_SECRET?.trim();
  const text = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Apinator MCP server failed: ${secret ? text.split(secret).join("[redacted]") : text}\n`);
  process.exit(1);
});
