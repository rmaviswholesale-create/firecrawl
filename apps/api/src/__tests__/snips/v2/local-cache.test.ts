import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { config } from "../../../config";
import { HAS_PROXY, itIf, TEST_SELF_HOST } from "../lib";
import { Identity, idmux, scrape, scrapeTimeout } from "./lib";

// The local page cache (LOCAL_CACHE_ENABLED) replays a recent scrape of the
// same URL instead of loading the page again. The page is served from this
// process so the test can count how often it is really fetched.
const LOCAL_CACHE =
  TEST_SELF_HOST && !HAS_PROXY && config.LOCAL_CACHE_ENABLED === true;

let identity: Identity;
let server: http.Server;
let baseUrl: string;
const hits = new Map<string, number>();

const hitsFor = (url: string) => hits.get(new URL(url).pathname) ?? 0;

beforeAll(async () => {
  identity = await idmux({
    name: "local-cache",
    concurrency: 20,
    credits: 1000000,
  });

  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/favicon.ico") {
      res.writeHead(404).end();
      return;
    }
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>Counter</title></head><body><main>` +
        `<h1>Counter</h1><p>This page has been served ${count} time(s).</p>` +
        `</main></body></html>`,
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 10000);

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe("Local page cache", () => {
  itIf(LOCAL_CACHE)(
    "serves a repeat scrape from the cache within maxAge",
    async () => {
      const url = `${baseUrl}/${crypto.randomUUID()}`;

      const first = await scrape({ url, maxAge: 600000 }, identity);
      expect(first.metadata.cacheState).toBe("miss");
      expect(first.markdown).toContain("served 1 time(s)");

      const second = await scrape({ url, maxAge: 600000 }, identity);
      expect(second.metadata.cacheState).toBe("hit");
      expect(second.metadata.cachedAt).toEqual(expect.any(String));
      expect(second.markdown).toContain("served 1 time(s)");
      expect(hitsFor(url)).toBe(1);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_CACHE)(
    "scrapes live when maxAge is 0",
    async () => {
      const url = `${baseUrl}/${crypto.randomUUID()}`;

      await scrape({ url, maxAge: 600000 }, identity);
      const fresh = await scrape({ url, maxAge: 0 }, identity);

      expect(fresh.metadata.cacheState).toBe("miss");
      expect(fresh.markdown).toContain("served 2 time(s)");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_CACHE)(
    "does not store a scrape that opts out with storeInCache",
    async () => {
      const url = `${baseUrl}/${crypto.randomUUID()}`;

      await scrape({ url, maxAge: 600000, storeInCache: false }, identity);
      const second = await scrape({ url, maxAge: 600000 }, identity);

      expect(second.metadata.cacheState).toBe("miss");
      expect(second.markdown).toContain("served 2 time(s)");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_CACHE)(
    "never caches a request with custom headers",
    async () => {
      const url = `${baseUrl}/${crypto.randomUUID()}`;
      const body = { url, maxAge: 600000, headers: { "X-Session": "abc" } };

      await scrape(body, identity);
      const second = await scrape(body, identity);

      expect(second.metadata.cacheState).toBeUndefined();
      expect(second.markdown).toContain("served 2 time(s)");
    },
    scrapeTimeout,
  );
});
