import { describe, expect, it } from "vitest";
import {
  bearerToken,
  isSelfHostedApiKey,
  parseSelfHostedApiKeys,
} from "./self-hosted-auth";

describe("self-hosted API keys", () => {
  it("parses a comma-separated list and ignores blanks", () => {
    expect(parseSelfHostedApiKeys(" a , ,b,")).toEqual(["a", "b"]);
    expect(parseSelfHostedApiKeys(undefined)).toEqual([]);
    expect(parseSelfHostedApiKeys("")).toEqual([]);
  });

  it("reads only Bearer tokens", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("abc")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("matches only a configured key", () => {
    expect(isSelfHostedApiKey("b", ["a", "b"])).toBe(true);
    expect(isSelfHostedApiKey("c", ["a", "b"])).toBe(false);
    expect(isSelfHostedApiKey("", ["a"])).toBe(false);
    expect(isSelfHostedApiKey(null, ["a"])).toBe(false);
    expect(isSelfHostedApiKey("a", [])).toBe(false);
  });
});
