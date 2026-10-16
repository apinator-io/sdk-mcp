/**
 * Runtime configuration, read from environment variables.
 */
export interface Config {
  /** Application ID (APINATOR_APP_ID). */
  appId: string;
  /** API key (APINATOR_KEY). Public: browsers use it to connect. */
  key: string;
  /** API secret (APINATOR_SECRET). Never returned by any tool. */
  secret: string;
  /** Cluster / region, e.g. "eu" or "us" (APINATOR_CLUSTER). */
  cluster: string;
  /** When true, `publish_event` is not registered (APINATOR_READ_ONLY=1). */
  readOnly: boolean;
  /** REST base URL. Defaults to https://ws-{cluster}.apinator.io. */
  apiUrl: string;
  /** WebSocket base URL. Defaults to wss://ws-{cluster}.apinator.io. */
  wsUrl: string;
}

/** Thrown when the environment is missing or has invalid settings. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      "Apinator MCP server is not configured:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nFind these values in the Apinator console (https://console.apinator.io) " +
        "under your app's API keys, and pass them as environment variables in your MCP client config."
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * Reads and validates configuration from `env`.
 *
 * APINATOR_API_URL and APINATOR_WS_URL are optional overrides for pointing the
 * server at a local or self-hosted data plane; normal users never set them.
 *
 * @throws {ConfigError} listing every problem found, so they can all be fixed at once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const read = (name: string): string => (env[name] ?? "").trim();

  const appId = read("APINATOR_APP_ID");
  const key = read("APINATOR_KEY");
  const secret = read("APINATOR_SECRET");
  const cluster = read("APINATOR_CLUSTER").toLowerCase();

  if (!appId) problems.push("APINATOR_APP_ID is not set.");
  if (!key) problems.push("APINATOR_KEY is not set.");
  if (!secret) problems.push("APINATOR_SECRET is not set.");
  if (key && secret && key === secret) {
    problems.push("APINATOR_KEY and APINATOR_SECRET are the same value; check you copied both.");
  }
  if (!cluster) {
    problems.push('APINATOR_CLUSTER is not set. Use the region your app was created in, e.g. "eu" or "us".');
  } else if (!/^[a-z0-9-]+$/.test(cluster)) {
    problems.push(
      `APINATOR_CLUSTER must be a region id like "eu" or "us" (got ${JSON.stringify(cluster)}).`
    );
  }

  const readOnlyRaw = read("APINATOR_READ_ONLY").toLowerCase();
  let readOnly = false;
  if (TRUE_VALUES.has(readOnlyRaw)) {
    readOnly = true;
  } else if (!FALSE_VALUES.has(readOnlyRaw)) {
    problems.push(`APINATOR_READ_ONLY must be 1 or 0 (got ${JSON.stringify(readOnlyRaw)}).`);
  }

  const apiUrl = parseBaseUrl("APINATOR_API_URL", read("APINATOR_API_URL"), ["http:", "https:"], problems);
  const wsUrl = parseBaseUrl("APINATOR_WS_URL", read("APINATOR_WS_URL"), ["ws:", "wss:"], problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    appId,
    key,
    secret,
    cluster,
    readOnly,
    apiUrl: apiUrl ?? `https://ws-${cluster}.apinator.io`,
    wsUrl: wsUrl ?? `wss://ws-${cluster}.apinator.io`,
  };
}

function parseBaseUrl(
  name: string,
  value: string,
  protocols: string[],
  problems: string[]
): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} is not a valid URL.`);
    return undefined;
  }
  if (!protocols.includes(url.protocol)) {
    problems.push(`${name} must start with ${protocols.map((p) => `${p}//`).join(" or ")}.`);
    return undefined;
  }
  return value.replace(/\/+$/, "");
}
