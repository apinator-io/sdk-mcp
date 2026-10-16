import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

const base = {
  APINATOR_APP_ID: "app-1",
  APINATOR_KEY: "key-1",
  APINATOR_SECRET: "secret-1",
  APINATOR_CLUSTER: "eu",
};

describe("loadConfig", () => {
  it("reads a complete environment and derives the cluster URLs", () => {
    expect(loadConfig(base)).toEqual({
      appId: "app-1",
      key: "key-1",
      secret: "secret-1",
      cluster: "eu",
      readOnly: false,
      apiUrl: "https://ws-eu.apinator.io",
      wsUrl: "wss://ws-eu.apinator.io",
    });
  });

  it("trims whitespace and lowercases the cluster", () => {
    const config = loadConfig({ ...base, APINATOR_KEY: "  key-1\n", APINATOR_CLUSTER: " US " });
    expect(config.key).toBe("key-1");
    expect(config.cluster).toBe("us");
    expect(config.apiUrl).toBe("https://ws-us.apinator.io");
  });

  it("lists every missing variable at once", () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems;
      expect(problems).toHaveLength(4);
      expect(problems.join("\n")).toMatch(/APINATOR_APP_ID[\s\S]*APINATOR_KEY[\s\S]*APINATOR_SECRET[\s\S]*APINATOR_CLUSTER/);
      expect((error as Error).message).toContain("console.apinator.io");
    }
  });

  it("rejects a malformed cluster", () => {
    expect(() => loadConfig({ ...base, APINATOR_CLUSTER: "ws-eu.apinator.io" })).toThrow(/region id/);
  });

  it("flags a key pasted into the secret, without echoing it", () => {
    try {
      loadConfig({ ...base, APINATOR_SECRET: "key-1" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/same value/);
      expect((error as Error).message).not.toContain("key-1");
    }
  });

  it.each([
    ["1", true],
    ["true", true],
    ["YES", true],
    ["0", false],
    ["", false],
    ["false", false],
  ])("APINATOR_READ_ONLY=%j → %s", (value, expected) => {
    expect(loadConfig({ ...base, APINATOR_READ_ONLY: value }).readOnly).toBe(expected);
  });

  it("rejects an unrecognised APINATOR_READ_ONLY", () => {
    expect(() => loadConfig({ ...base, APINATOR_READ_ONLY: "maybe" })).toThrow(/APINATOR_READ_ONLY/);
  });

  it("accepts URL overrides for a local data plane and strips trailing slashes", () => {
    const config = loadConfig({
      ...base,
      APINATOR_API_URL: "http://localhost:8081/",
      APINATOR_WS_URL: "ws://localhost:8081",
    });
    expect(config.apiUrl).toBe("http://localhost:8081");
    expect(config.wsUrl).toBe("ws://localhost:8081");
  });

  it("rejects overrides with the wrong scheme", () => {
    expect(() => loadConfig({ ...base, APINATOR_WS_URL: "http://localhost:8081" })).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => loadConfig({ ...base, APINATOR_API_URL: "not a url" })).toThrow(/not a valid URL/);
  });
});
