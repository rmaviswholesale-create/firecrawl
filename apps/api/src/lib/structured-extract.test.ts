import { describe, expect, it } from "vitest";
import {
  diffStructuredValues,
  extractStructuredData,
} from "./structured-extract";

describe("extractStructuredData", () => {
  const sampleHtml = `
    <!doctype html>
    <html>
      <head>
        <meta property="og:title" content="Acme Widget" />
        <meta property="og:price:amount" content="49.99" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="alternate" type="application/rss+xml" title="Blog RSS" href="/feed.xml" />
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "Product", "name": "Acme Widget", "sku": "W-100" }
            ]
          }
        </script>
      </head>
      <body>
        <h1>Acme Store</h1>
        <div class="product">
          <h2>Widget Pro</h2>
          <span class="price">$49.99</span>
          <span class="stock">In Stock</span>
          <a href="/products/widget-pro">View</a>
        </div>
        <div class="product">
          <h2>Widget Lite</h2>
          <span class="price">$19.50</span>
          <span class="stock">Out of Stock</span>
          <a href="/products/widget-lite">View</a>
        </div>
        <table>
          <caption>Pricing Tiers</caption>
          <thead><tr><th>Plan</th><th>Price</th></tr></thead>
          <tbody>
            <tr><td>Starter</td><td>$0</td></tr>
            <tr><td>Pro</td><td>$29</td></tr>
          </tbody>
        </table>
      </body>
    </html>
  `;

  it("auto-discovers JSON-LD, OpenGraph, Twitter, tables, and feeds", () => {
    const res = extractStructuredData(
      sampleHtml,
      {},
      "https://shop.example.com/catalog",
    );

    expect(res.data).toBeUndefined();
    expect(res.jsonLd).toEqual([
      { "@type": "Product", name: "Acme Widget", sku: "W-100" },
    ]);
    expect(res.openGraph).toEqual({
      title: "Acme Widget",
      "price:amount": "49.99",
    });
    expect(res.twitter).toEqual({ card: "summary_large_image" });
    expect(res.feeds).toEqual([
      {
        title: "Blog RSS",
        type: "application/rss+xml",
        href: "https://shop.example.com/feed.xml",
      },
    ]);
    expect(res.tables).toEqual([
      {
        caption: "Pricing Tiers",
        headers: ["Plan", "Price"],
        rows: [
          { Plan: "Starter", Price: "$0" },
          { Plan: "Pro", Price: "$29" },
        ],
      },
    ]);
  });

  it("runs declarative CSS rules with nested fields, attributes, regex, and transforms", () => {
    const res = extractStructuredData(
      sampleHtml,
      {
        rules: {
          heading: "h1",
          products: {
            selector: ".product",
            all: true,
            fields: {
              name: "h2",
              price: { selector: ".price", transform: "number" },
              inStock: { selector: ".stock", transform: "boolean" },
              url: { selector: "a", attr: "href", transform: "url" },
              slug: {
                selector: "a",
                attr: "href",
                regex: "/products/([a-z-]+)$",
              },
            },
          },
        },
      },
      "https://shop.example.com/catalog",
    );

    expect(res.jsonLd).toBeUndefined();
    expect(res.data).toEqual({
      heading: "Acme Store",
      products: [
        {
          name: "Widget Pro",
          price: 49.99,
          inStock: true,
          url: "https://shop.example.com/products/widget-pro",
          slug: "widget-pro",
        },
        {
          name: "Widget Lite",
          price: 19.5,
          inStock: false,
          url: "https://shop.example.com/products/widget-lite",
          slug: "widget-lite",
        },
      ],
    });
  });

  it("handles missing selectors and invalid regex gracefully", () => {
    const res = extractStructuredData("<div>hello</div>", {
      rules: {
        missing: ".does-not-exist",
        badRegex: { selector: "div", regex: "[unclosed" },
      },
    });
    expect(res.data).toEqual({ missing: null, badRegex: null });
  });
});

describe("diffStructuredValues", () => {
  it("reports leaf-level changes across nested objects and arrays", () => {
    const before = {
      title: "Acme",
      products: [
        { name: "Widget Pro", price: 49.99, inStock: true },
        { name: "Widget Lite", price: 19.5, inStock: false },
      ],
    };
    const after = {
      title: "Acme",
      products: [
        { name: "Widget Pro", price: 39.99, inStock: true },
        { name: "Widget Lite", price: 19.5, inStock: true },
      ],
    };
    expect(diffStructuredValues(before, after)).toEqual([
      { path: "products[0].price", before: 49.99, after: 39.99 },
      { path: "products[1].inStock", before: false, after: true },
    ]);
  });

  it("returns an empty array when values are identical", () => {
    const value = { price: 10, tags: ["a", "b"] };
    expect(
      diffStructuredValues(value, { price: 10, tags: ["a", "b"] }),
    ).toEqual([]);
  });
});

describe("extractStructuredData hardening", () => {
  it("parses number and integer transforms from prose with 'e' and decimals", () => {
    const html = `
      <span class="p1">Price: $49.99</span>
      <span class="p2">Save $5</span>
      <span class="p3">1,250 items left</span>
      <span class="int">$49.99</span>
    `;
    const res = extractStructuredData(html, {
      includeAuto: false,
      includeTables: false,
      rules: {
        p1: { selector: ".p1", transform: "number" },
        p2: { selector: ".p2", transform: "number" },
        p3: { selector: ".p3", transform: "number" },
        int: { selector: ".int", transform: "integer" },
      },
    });
    expect(res.data).toEqual({
      p1: 49.99,
      p2: 5,
      p3: 1250,
      int: 49,
    });
  });

  it("rejects catastrophic backtracking regexes and unsafe __proto__ keys", () => {
    const html = `
      <html><head><meta property="og:toString" content="safe-og" /></head>
      <body>
        <p class="redos">aaaaaaaaaaaaaaaaaaaaaaaaaaaa!</p>
        <table><thead><tr><th>__proto__</th><th>Name</th></tr></thead>
        <tbody><tr><td>bad</td><td>Widget</td></tr></tbody></table>
      </body></html>
    `;
    const res = extractStructuredData(html, {
      includeAuto: true,
      includeTables: true,
      rules: {
        redos: { selector: ".redos", regex: "(a+)+$" },
      },
    });
    expect(res.data).toEqual({ redos: null });
    expect(res.openGraph).toEqual({ toString: "safe-og" });
    expect(Object.getPrototypeOf(res.tables![0].rows[0])).toBe(
      Object.prototype,
    );
    expect(res.tables![0].rows[0]).toEqual({ Name: "Widget" });
  });
});
