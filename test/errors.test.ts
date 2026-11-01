import { ApiError, AuthenticationError } from "@apinator/server";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/errors.js";

describe("describeError", () => {
  it("does not double the period when the API message already ends with one", () => {
    const message = describeError(
      new AuthenticationError("invalid api key. Check your app's API keys in the console."),
      "secret",
    );
    expect(message).toContain("in the console. Check APINATOR_APP_ID");
    expect(message).not.toContain("..");
  });

  it("adds a period when the API message has none", () => {
    expect(describeError(new AuthenticationError("invalid signature"), "secret")).toContain(
      "invalid signature. Check APINATOR_APP_ID",
    );
  });

  it("joins 404 and 429 hints the same way", () => {
    expect(describeError(new ApiError("app not found.", 404, ""), "secret")).toBe(
      "Not found (HTTP 404): app not found. Check APINATOR_APP_ID and APINATOR_CLUSTER.",
    );
    expect(describeError(new ApiError("slow down", 429, ""), "secret")).toBe(
      "Rate limited by Apinator (HTTP 429): slow down. Wait a moment and retry.",
    );
  });
});
