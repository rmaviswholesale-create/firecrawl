import { describe, expect, it } from "vitest";
import { filterSearchResultsByDomain } from "./index";

describe("filterSearchResultsByDomain", () => {
  const sample = {
    web: [
      { url: "https://docs.example.com/guide", title: "Docs", description: "" },
      { url: "https://example.com/pricing", title: "Pricing", description: "" },
      { url: "https://other.org/page", title: "Other", description: "" },
      { url: "https://spam.net/ad", title: "Spam", description: "" },
    ],
  };

  it("enforces includeDomains including subdomains", () => {
    const filtered = filterSearchResultsByDomain(sample, ["example.com"]);
    expect(filtered.web?.map(r => r.url)).toEqual([
      "https://docs.example.com/guide",
      "https://example.com/pricing",
    ]);
  });

  it("enforces excludeDomains", () => {
    const filtered = filterSearchResultsByDomain(sample, undefined, [
      "spam.net",
      "other.org",
    ]);
    expect(filtered.web?.map(r => r.url)).toEqual([
      "https://docs.example.com/guide",
      "https://example.com/pricing",
    ]);
  });

  it("combines includeDomains and excludeDomains", () => {
    const filtered = filterSearchResultsByDomain(
      sample,
      ["example.com"],
      ["docs.example.com"],
    );
    expect(filtered.web?.map(r => r.url)).toEqual([
      "https://example.com/pricing",
    ]);
  });

  it("normalizes trailing dots and ports on domain filters", () => {
    const filtered = filterSearchResultsByDomain(sample, [
      "example.com.",
      "other.org:8443",
    ]);
    expect(filtered.web?.map(r => r.url)).toEqual([
      "https://docs.example.com/guide",
      "https://example.com/pricing",
      "https://other.org/page",
    ]);
  });
});
