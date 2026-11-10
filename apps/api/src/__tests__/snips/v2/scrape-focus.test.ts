import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { HAS_PROXY, itIf, TEST_SELF_HOST } from "../lib";
import { Identity, idmux, scrape, scrapeRaw, scrapeTimeout } from "./lib";

// The focus format returns the parts of a page that match a query, within a
// token budget, without calling a model. The page is served from this process.
const LOCAL_PAGE = TEST_SELF_HOST && !HAS_PROXY;

const filler = (topic: string) =>
  Array.from(
    { length: 12 },
    (_, i) =>
      `<p>${topic} paragraph ${i}: general background that fills the page with unrelated prose about gardening, weather and travel.</p>`,
  ).join("");

const PAGE =
  `<!doctype html><html><head><title>Handbook</title></head><body><main>` +
  `<h1>Company Handbook</h1>` +
  `<h2>Office Locations</h2>${filler("Offices")}` +
  `<h2>Refund Policy</h2>` +
  `<p>Customers may request a refund within 30 days of purchase.</p>` +
  `<p>Refunds are returned to the original payment method within 5 business days.</p>` +
  `<h2>Company History</h2>${filler("History")}` +
  `</main></body></html>`;

let identity: Identity;
let server: http.Server;
let pageUrl: string;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-focus",
    concurrency: 20,
    credits: 1000000,
  });

  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/handbook`;
}, 10000);

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe("Focus format", () => {
  itIf(LOCAL_PAGE)(
    "returns the sections that match the query within the token budget",
    async () => {
      const doc = await scrape(
        {
          url: pageUrl,
          formats: [
            {
              type: "focus",
              query: "how long do refunds take",
              maxTokens: 120,
            },
          ],
        },
        identity,
      );

      expect(doc.markdown).toBeUndefined();
      expect(doc.focus?.markdown).toContain("## Refund Policy");
      expect(doc.focus?.markdown).toContain("within 5 business days");
      expect(doc.focus?.markdown).not.toContain("gardening");
      expect(doc.focus?.estimatedTokens).toBeLessThanOrEqual(120);
      expect(doc.focus?.sourceEstimatedTokens).toBeGreaterThan(
        doc.focus!.estimatedTokens,
      );
      expect(doc.focus?.sections[0]?.heading).toBe("Refund Policy");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_PAGE)(
    "warns and returns empty markdown when nothing matches",
    async () => {
      const doc = await scrape(
        {
          url: pageUrl,
          formats: [{ type: "focus", query: "kubernetes zebra quantum" }],
        },
        identity,
      );

      expect(doc.focus?.markdown).toBe("");
      expect(doc.warning).toContain("No part of the page matched");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_PAGE)(
    "rejects a focus format without a query",
    async () => {
      const raw = await scrapeRaw(
        { url: pageUrl, formats: [{ type: "focus" }] },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
