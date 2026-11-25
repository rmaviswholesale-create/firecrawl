import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { HAS_PROXY, itIf, TEST_SELF_HOST } from "../lib";
import { Identity, idmux, scrape, scrapeRaw, scrapeTimeout } from "./lib";

const LOCAL_PAGE = TEST_SELF_HOST && !HAS_PROXY;

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Store</title>
    <meta property="og:title" content="Storefront" />
    <meta name="twitter:site" content="@storefront" />
    <link rel="alternate" type="application/rss+xml" title="Updates" href="/rss.xml" />
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Organization","name":"Storefront Inc"}
    </script>
  </head>
  <body>
    <main>
      <h1>Featured Products</h1>
      <div class="item">
        <h2>Alpha</h2>
        <span class="price">$42.50</span>
        <a href="/items/alpha">Details</a>
      </div>
      <div class="item">
        <h2>Beta</h2>
        <span class="price">$19.00</span>
        <a href="/items/beta">Details</a>
      </div>
      <table>
        <thead><tr><th>Tier</th><th>Quota</th></tr></thead>
        <tbody>
          <tr><td>Free</td><td>100</td></tr>
          <tr><td>Self-Hosted</td><td>Unlimited</td></tr>
        </tbody>
      </table>
    </main>
  </body>
</html>`;

let identity: Identity;
let server: http.Server;
let pageUrl: string;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-structured",
    concurrency: 20,
    credits: 1000000,
  });

  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/store`;
}, 10000);

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe("Structured format", () => {
  itIf(LOCAL_PAGE)(
    "auto-discovers JSON-LD, OpenGraph, Twitter, tables, and feeds with shorthand string format",
    async () => {
      const doc = await scrape(
        {
          url: pageUrl,
          formats: ["structured"],
        },
        identity,
      );

      expect(doc.structured?.jsonLd).toEqual([
        {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "Storefront Inc",
        },
      ]);
      expect(doc.structured?.openGraph).toEqual({ title: "Storefront" });
      expect(doc.structured?.twitter).toEqual({ site: "@storefront" });
      expect(doc.structured?.feeds).toEqual([
        {
          title: "Updates",
          type: "application/rss+xml",
          href: new URL("/rss.xml", pageUrl).toString(),
        },
      ]);
      expect(doc.structured?.tables).toEqual([
        {
          headers: ["Tier", "Quota"],
          rows: [
            { Tier: "Free", Quota: "100" },
            { Tier: "Self-Hosted", Quota: "Unlimited" },
          ],
        },
      ]);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_PAGE)(
    "extracts nested typed objects using declarative CSS rules",
    async () => {
      const doc = await scrape(
        {
          url: pageUrl,
          formats: [
            {
              type: "structured",
              rules: {
                heading: "h1",
                items: {
                  selector: ".item",
                  all: true,
                  fields: {
                    name: "h2",
                    price: { selector: ".price", transform: "number" },
                    url: { selector: "a", attr: "href", transform: "url" },
                  },
                },
              },
            },
          ],
        },
        identity,
      );

      expect(doc.structured?.jsonLd).toBeUndefined();
      expect(doc.structured?.data).toEqual({
        heading: "Featured Products",
        items: [
          {
            name: "Alpha",
            price: 42.5,
            url: new URL("/items/alpha", pageUrl).toString(),
          },
          {
            name: "Beta",
            price: 19,
            url: new URL("/items/beta", pageUrl).toString(),
          },
        ],
      });
    },
    scrapeTimeout,
  );

  itIf(LOCAL_PAGE)(
    "rejects invalid structured format rules",
    async () => {
      const raw = await scrapeRaw(
        {
          url: pageUrl,
          formats: [
            {
              type: "structured",
              rules: { bad: { selector: "" } },
            },
          ],
        },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
