import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { HAS_PROXY, itIf, TEST_SELF_HOST } from "../lib";
import request, {
  Identity,
  idmux,
  scrape,
  scrapeRaw,
  scrapeTimeout,
  TEST_API_URL,
} from "./lib";

// Change tracking on the local snapshot store: no Bigtable, no GCS, and a
// page can be compared against any earlier version, not only the last scrape.
// The page under test is served from this process so the test can change it.
const LOCAL_SNAPSHOTS = TEST_SELF_HOST && !HAS_PROXY;

let identity: Identity;
let server: http.Server;
let pageUrl: string;
let price = "$10";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const snapshotsGet = (path: string) =>
  request(TEST_API_URL)
    .get(path)
    .set("Authorization", `Bearer ${identity.apiKey}`);

beforeAll(async () => {
  identity = await idmux({
    name: "snapshots",
    concurrency: 20,
    credits: 1000000,
  });

  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>Pricing</title></head><body><main>` +
        `<h1>Pricing</h1><p>The standard plan costs ${price} per month.</p>` +
        `</main></body></html>`,
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  pageUrl = `http://127.0.0.1:${port}/pricing?run=${crypto.randomUUID()}`;
}, 10000);

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe("Local snapshot store", () => {
  itIf(LOCAL_SNAPSHOTS)(
    "tracks changes, time travels with since, and serves history",
    async () => {
      const track = (since?: string) =>
        scrape(
          {
            url: pageUrl,
            formats: [
              "markdown",
              {
                type: "changeTracking",
                modes: ["git-diff"],
                ...(since ? { since } : {}),
              },
            ],
          },
          identity,
        );

      const first = await track();
      expect(first.changeTracking?.changeStatus).toBe("new");
      expect(first.changeTracking?.previousScrapeAt).toBeNull();
      expect(first.changeTracking?.comparedTo).toBeNull();
      const firstId = first.changeTracking?.snapshotId;
      expect(firstId).toEqual(expect.any(String));

      const second = await track();
      expect(second.changeTracking?.changeStatus).toBe("same");
      expect(second.changeTracking?.snapshotId).toBe(firstId);
      expect(second.changeTracking?.comparedTo?.snapshotId).toBe(firstId);

      await sleep(50);
      const afterFirstVersion = new Date().toISOString();
      await sleep(50);

      price = "$20";
      const third = await track();
      expect(third.changeTracking?.changeStatus).toBe("changed");
      expect(third.changeTracking?.comparedTo?.snapshotId).toBe(firstId);
      expect(third.changeTracking?.diff?.text).toContain("$10");
      expect(third.changeTracking?.diff?.text).toContain("$20");
      const thirdId = third.changeTracking?.snapshotId;
      expect(thirdId).not.toBe(firstId);

      // Without since this compares $30 to $20; with it, to the $10 version.
      price = "$30";
      const fourth = await track(afterFirstVersion);
      expect(fourth.changeTracking?.changeStatus).toBe("changed");
      expect(fourth.changeTracking?.comparedTo?.snapshotId).toBe(firstId);
      expect(fourth.changeTracking?.diff?.text).toContain("$10");
      expect(fourth.changeTracking?.diff?.text).toContain("$30");
      expect(fourth.changeTracking?.diff?.text).not.toContain("$20");
      const fourthId = fourth.changeTracking?.snapshotId;

      const list = await snapshotsGet(
        `/v2/snapshots?url=${encodeURIComponent(pageUrl)}`,
      );
      expect(list.statusCode).toBe(200);
      expect(list.body.snapshots.map((s: { id: string }) => s.id)).toEqual([
        fourthId,
        thirdId,
        firstId,
      ]);

      const one = await snapshotsGet(`/v2/snapshots/${thirdId}`);
      expect(one.statusCode).toBe(200);
      expect(one.body.snapshot.markdown).toContain("$20");

      const diff = await snapshotsGet(
        `/v2/snapshots/diff?from=${firstId}&to=${fourthId}`,
      );
      expect(diff.statusCode).toBe(200);
      expect(diff.body.changeStatus).toBe("changed");
      expect(diff.body.diff.text).toContain("$30");
    },
    6 * scrapeTimeout,
  );

  itIf(LOCAL_SNAPSHOTS)(
    "returns 404 for an unknown snapshot and 400 for a bad query",
    async () => {
      const missing = await snapshotsGet(
        `/v2/snapshots/${crypto.randomUUID()}`,
      );
      expect(missing.statusCode).toBe(404);
      expect(missing.body.success).toBe(false);

      const noUrl = await snapshotsGet("/v2/snapshots");
      expect(noUrl.statusCode).toBe(400);

      const badDiff = await snapshotsGet(
        "/v2/snapshots/diff?from=nope&to=nope",
      );
      expect(badDiff.statusCode).toBe(400);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_SNAPSHOTS)(
    "rejects a since value that is not a time",
    async () => {
      const raw = await scrapeRaw(
        {
          url: pageUrl,
          formats: ["markdown", { type: "changeTracking", since: "recently" }],
        },
        identity,
      );
      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
