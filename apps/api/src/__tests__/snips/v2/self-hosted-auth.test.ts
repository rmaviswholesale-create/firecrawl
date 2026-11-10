import { describe, expect } from "vitest";
import { config } from "../../../config";
import { itIf, TEST_SELF_HOST, TEST_SUITE_WEBSITE } from "../lib";
import request, { Identity, idmux, scrapeTimeout, TEST_API_URL } from "./lib";

// With SELF_HOSTED_API_KEYS set, a deployment without DB authentication
// accepts only requests that carry one of the keys. TEST_API_KEY must be one
// of them for the rest of the suite to pass.
const KEYS_REQUIRED = TEST_SELF_HOST && !!config.SELF_HOSTED_API_KEYS;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "self-hosted-auth",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

const scrapeWith = (authorization: string | undefined) => {
  const req = request(TEST_API_URL)
    .post("/v2/scrape")
    .set("Content-Type", "application/json");
  if (authorization !== undefined) req.set("Authorization", authorization);
  return req.send({ url: TEST_SUITE_WEBSITE });
};

describe("Self-hosted API keys", () => {
  itIf(KEYS_REQUIRED)(
    "accepts a configured key",
    async () => {
      const raw = await scrapeWith(`Bearer ${identity.apiKey}`);
      expect(raw.statusCode).toBe(200);
      expect(raw.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  itIf(KEYS_REQUIRED)(
    "rejects a wrong key, a missing key and a non-Bearer header",
    async () => {
      for (const header of [
        "Bearer not-a-configured-key",
        undefined,
        identity.apiKey,
      ]) {
        const raw = await scrapeWith(header);
        expect(raw.statusCode).toBe(401);
        expect(raw.body.success).toBe(false);
      }
    },
    scrapeTimeout,
  );

  itIf(KEYS_REQUIRED)(
    "protects read endpoints as well",
    async () => {
      const raw = await request(TEST_API_URL)
        .get(`/v2/snapshots?url=${encodeURIComponent(TEST_SUITE_WEBSITE)}`)
        .set("Authorization", "Bearer not-a-configured-key");
      expect(raw.statusCode).toBe(401);
    },
    scrapeTimeout,
  );
});
