import { load, type Cheerio, type CheerioAPI } from "cheerio";

/**
 * Deterministic, zero-LLM structured data extraction from HTML.
 *
 * Supports two complementary modes:
 * 1. Auto-discovery (`includeAuto`): parses JSON-LD, OpenGraph, Twitter Cards,
 *    HTML tables (into typed header/row records), and RSS/Atom/JSON feed links.
 * 2. Declarative CSS rules (`rules`): extracts single values, arrays (`all`),
 *    nested repeating structures (`fields`), attributes (`attr`), regex capture
 *    groups, and typed transforms (`number`, `integer`, `boolean`, `url`, etc.).
 */

type ExtractTransform =
  | "trim"
  | "number"
  | "integer"
  | "boolean"
  | "url"
  | "lowercase"
  | "uppercase";

type ExtractRuleObject = {
  selector: string;
  attr?: string;
  all?: boolean;
  regex?: string;
  transform?: ExtractTransform;
  fields?: Record<string, ExtractRule>;
};

export type ExtractRule = string | ExtractRuleObject;

export type StructuredExtractOptions = {
  rules?: Record<string, ExtractRule>;
  includeAuto?: boolean;
  includeTables?: boolean;
};

type StructuredTable = {
  caption?: string;
  headers: string[];
  rows: Record<string, string>[];
};

type StructuredFeed = {
  title?: string;
  type: string;
  href: string;
};

export type StructuredResult = {
  data?: Record<string, unknown>;
  jsonLd?: unknown[];
  openGraph?: Record<string, string>;
  twitter?: Record<string, string>;
  tables?: StructuredTable[];
  feeds?: StructuredFeed[];
};

export type FieldChange = {
  path: string;
  before: unknown;
  after: unknown;
};

const MAX_ITEMS_PER_RULE = 500;
const MAX_RULE_DEPTH = 4;
const MAX_TABLES = 50;
const MAX_TABLE_ROWS = 500;
const MAX_REGEX_INPUT_CHARS = 10_000;

function resolveUrl(value: string, baseUrl?: string): string {
  const trimmed = value.trim();
  if (!trimmed || !baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function applyTransform(
  raw: string,
  transform: ExtractTransform | undefined,
  baseUrl?: string,
): unknown {
  const trimmed = raw.trim();
  switch (transform) {
    case undefined:
    case "trim":
      return trimmed;
    case "lowercase":
      return trimmed.toLowerCase();
    case "uppercase":
      return trimmed.toUpperCase();
    case "url":
      return resolveUrl(trimmed, baseUrl);
    case "number": {
      const noCommas = trimmed.replace(/,/g, "");
      const match = noCommas.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) return null;
      const num = Number(match[0]);
      return Number.isFinite(num) ? num : null;
    }
    case "integer": {
      const noCommas = trimmed.replace(/,/g, "");
      const match = noCommas.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) return null;
      const num = Number(match[0]);
      return Number.isFinite(num) ? Math.trunc(num) : null;
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (["true", "yes", "1", "on", "in stock", "available"].includes(lower)) {
        return true;
      }
      if (
        ["false", "no", "0", "off", "out of stock", "unavailable"].includes(
          lower,
        )
      ) {
        return false;
      }
      return Boolean(trimmed);
    }
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeSet<T>(obj: Record<string, T>, key: string, value: T): void {
  if (!key || UNSAFE_KEYS.has(key)) return;
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isSafeRegex(pattern: string): boolean {
  // Reject obvious catastrophic backtracking (quantified groups containing quantifiers).
  return !/\((?:[^()\\]|\\.)*[+*?](?:[^()\\]|\\.)*\)[+*?{]/.test(pattern);
}

function applyRegex(value: string, pattern: string | undefined): string | null {
  if (!pattern) return value;
  if (!isSafeRegex(pattern)) return null;
  const bounded =
    value.length > MAX_REGEX_INPUT_CHARS
      ? value.slice(0, MAX_REGEX_INPUT_CHARS)
      : value;
  try {
    const match = new RegExp(pattern).exec(bounded);
    if (!match) return null;
    return match[1] !== undefined ? match[1] : match[0];
  } catch {
    return null;
  }
}

function readElementValue(
  $: CheerioAPI,
  el: Cheerio<any>,
  attr: string | undefined,
): string | null {
  if (!attr || attr === "text") {
    return el.text().replace(/\s+/g, " ").trim();
  }
  if (attr === "html") {
    return el.html()?.trim() ?? null;
  }
  const attrVal = el.attr(attr);
  return attrVal === undefined ? null : attrVal;
}

function normalizeRule(rule: ExtractRule): ExtractRuleObject {
  return typeof rule === "string" ? { selector: rule } : rule;
}

function evaluateRule(
  $: CheerioAPI,
  scope: Cheerio<any> | null,
  ruleInput: ExtractRule,
  baseUrl: string | undefined,
  depth: number,
): unknown {
  if (depth > MAX_RULE_DEPTH) return null;
  const rule = normalizeRule(ruleInput);

  let matched: Cheerio<any>;
  try {
    matched = scope ? scope.find(rule.selector) : $(rule.selector);
  } catch {
    return rule.all ? [] : null;
  }

  const extractOne = (el: Cheerio<any>): unknown => {
    if (rule.fields && Object.keys(rule.fields).length > 0) {
      const record: Record<string, unknown> = {};
      for (const [fieldName, childRule] of Object.entries(rule.fields)) {
        safeSet(
          record,
          fieldName,
          evaluateRule($, el, childRule, baseUrl, depth + 1),
        );
      }
      return record;
    }

    const raw = readElementValue($, el, rule.attr);
    if (raw === null) return null;
    const regexed = applyRegex(raw, rule.regex);
    if (regexed === null) return null;
    return applyTransform(regexed, rule.transform, baseUrl);
  };

  if (rule.all) {
    const items: unknown[] = [];
    const count = Math.min(matched.length, MAX_ITEMS_PER_RULE);
    for (let i = 0; i < count; i++) {
      items.push(extractOne(matched.eq(i)));
    }
    return items;
  }

  if (matched.length === 0) return null;
  return extractOne(matched.first());
}

function extractJsonLd($: CheerioAPI): unknown[] {
  const results: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text().trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      const pushItem = (item: unknown) => {
        if (
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Array.isArray((item as Record<string, unknown>)["@graph"])
        ) {
          for (const node of (item as Record<string, unknown>)[
            "@graph"
          ] as unknown[]) {
            results.push(node);
          }
        } else {
          results.push(item);
        }
      };
      if (Array.isArray(parsed)) {
        for (const item of parsed) pushItem(item);
      } else {
        pushItem(parsed);
      }
    } catch {
      // Skip malformed JSON-LD blocks.
    }
  });
  return results;
}

function extractMetaMap($: CheerioAPI, prefix: string): Record<string, string> {
  const map: Record<string, string> = {};
  $("meta").each((_, el) => {
    const key = $(el).attr("property") ?? $(el).attr("name") ?? "";
    const content = $(el).attr("content");
    if (key.startsWith(prefix) && content !== undefined) {
      const shortKey = key.slice(prefix.length);
      if (shortKey && !Object.hasOwn(map, shortKey)) {
        safeSet(map, shortKey, content.trim());
      }
    }
  });
  return map;
}

function extractTables($: CheerioAPI): StructuredTable[] {
  const tables: StructuredTable[] = [];
  $("table").each((_, tableEl) => {
    if (tables.length >= MAX_TABLES) return false;
    const $table = $(tableEl);
    // Skip nested layout tables that contain other tables.
    if ($table.find("table").length > 0) return;

    const caption =
      $table.find("caption").first().text().replace(/\s+/g, " ").trim() ||
      undefined;
    const rows: string[][] = [];
    let headers: string[] = [];

    const theadRows = $table.find("thead tr");
    if (theadRows.length > 0) {
      headers = theadRows
        .first()
        .find("th, td")
        .map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim())
        .get();
    }

    const bodySelector = theadRows.length > 0 ? "tbody tr" : "tr";
    let $rows = $table.find(bodySelector);
    if ($rows.length === 0 && theadRows.length > 0) {
      $rows = $table.find("tr").slice(1);
    }

    $rows.each((rowIndex, trEl) => {
      if (rows.length >= MAX_TABLE_ROWS) return false;
      const $tr = $(trEl);
      const cells = $tr
        .find("th, td")
        .map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim())
        .get();
      if (cells.length === 0 || cells.every(c => c === "")) return;

      if (headers.length === 0 && rowIndex === 0 && $tr.find("th").length > 0) {
        headers = cells;
        return;
      }
      rows.push(cells);
    });

    if (rows.length === 0) return;

    const maxCols = Math.max(headers.length, ...rows.map(r => r.length));
    const effectiveHeaders = Array.from({ length: maxCols }, (_, idx) => {
      const name = headers[idx]?.trim();
      return name || `col_${idx + 1}`;
    });

    const records = rows.map(cells => {
      const record: Record<string, string> = {};
      for (let i = 0; i < effectiveHeaders.length; i++) {
        safeSet(record, effectiveHeaders[i], cells[i] ?? "");
      }
      return record;
    });

    tables.push({
      ...(caption ? { caption } : {}),
      headers: effectiveHeaders,
      rows: records,
    });
  });
  return tables;
}

const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/json",
]);

function extractFeeds($: CheerioAPI, baseUrl?: string): StructuredFeed[] {
  const feeds: StructuredFeed[] = [];
  const seen = new Set<string>();
  $('link[rel~="alternate"]').each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase().split(";")[0].trim();
    const href = $(el).attr("href");
    if (!href || !FEED_TYPES.has(type)) return;
    const resolved = resolveUrl(href, baseUrl);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const title = $(el).attr("title")?.trim() || undefined;
    feeds.push({ ...(title ? { title } : {}), type, href: resolved });
  });
  return feeds;
}

export function extractStructuredData(
  html: string,
  options: StructuredExtractOptions = {},
  baseUrl?: string,
): StructuredResult {
  const $ = load(html);
  const result: StructuredResult = {};
  const hasRules = Boolean(
    options.rules && Object.keys(options.rules).length > 0,
  );
  const includeAuto = options.includeAuto ?? !hasRules;
  const includeTables = options.includeTables ?? true;

  if (hasRules && options.rules) {
    const data: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(options.rules)) {
      safeSet(data, key, evaluateRule($, null, rule, baseUrl, 0));
    }
    result.data = data;
  }

  if (includeAuto) {
    const jsonLd = extractJsonLd($);
    if (jsonLd.length > 0) result.jsonLd = jsonLd;

    const openGraph = extractMetaMap($, "og:");
    if (Object.keys(openGraph).length > 0) result.openGraph = openGraph;

    const twitter = extractMetaMap($, "twitter:");
    if (Object.keys(twitter).length > 0) result.twitter = twitter;

    if (includeTables) {
      const tables = extractTables($);
      if (tables.length > 0) result.tables = tables;
    }

    const feeds = extractFeeds($, baseUrl);
    if (feeds.length > 0) result.feeds = feeds;
  }

  return result;
}

/**
 * Computes a flat list of leaf-level field changes between two structured
 * extraction outputs. Used by structured watches to emit noise-free diffs.
 */
export function diffStructuredValues(
  before: unknown,
  after: unknown,
  prefix = "",
  out: FieldChange[] = [],
  limit = 200,
): FieldChange[] {
  if (out.length >= limit) return out;
  if (Object.is(before, after)) return out;

  if (Array.isArray(before) && Array.isArray(after)) {
    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen && out.length < limit; i++) {
      const path = `${prefix}[${i}]`;
      diffStructuredValues(before[i], after[i], path, out, limit);
    }
    return out;
  }

  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const key of keys) {
      if (out.length >= limit) break;
      const path = prefix ? `${prefix}.${key}` : key;
      diffStructuredValues(b[key], a[key], path, out, limit);
    }
    return out;
  }

  out.push({
    path: prefix || "$",
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  });
  return out;
}
