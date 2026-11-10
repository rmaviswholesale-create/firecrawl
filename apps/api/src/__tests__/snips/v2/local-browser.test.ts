import { describe, expect, it } from "vitest";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_PLAYWRIGHT,
  itIf,
  TEST_SELF_HOST,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { Identity, idmux, scrape, scrapeRaw, scrapeTimeout } from "./lib";

// Actions, screenshots, mobile emulation and network capture on the
// self-hosted Playwright engine. /interact.html reveals text on click, echoes
// typed input, reports its viewport width and fetches /example.json.
const INTERACT_URL = TEST_SUITE_WEBSITE + "/interact.html";

const LOCAL_BROWSER =
  TEST_SELF_HOST && HAS_PLAYWRIGHT && ALLOW_TEST_SUITE_WEBSITE;
const LOCAL_FETCH_ONLY =
  TEST_SELF_HOST && !HAS_PLAYWRIGHT && ALLOW_TEST_SUITE_WEBSITE;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "local-browser",
    concurrency: 20,
    credits: 1000000,
  });
}, 10000);

describe("Self-hosted browser engine", () => {
  itIf(LOCAL_BROWSER)(
    "runs actions and returns their results",
    async () => {
      const doc = await scrape(
        {
          url: INTERACT_URL,
          formats: ["markdown"],
          actions: [
            { type: "wait", selector: "#reveal" },
            { type: "click", selector: "#reveal" },
            { type: "click", selector: "#name" },
            { type: "write", text: "firecrawl" },
            { type: "executeJavascript", script: "document.title" },
            { type: "screenshot" },
            { type: "scrape" },
          ],
        },
        identity,
      );

      expect(doc.markdown).toContain("firecrawl-actions-ok");
      expect(doc.markdown).toContain("Typed: firecrawl");
      expect(doc.actions?.javascriptReturns).toEqual([
        { type: "string", value: "Interaction Test" },
      ]);
      expect(doc.actions?.screenshots).toHaveLength(1);
      expect(doc.actions?.screenshots?.[0]).toMatch(/^data:image\/png;base64,/);
      expect(doc.actions?.scrapes?.[0]?.html).toContain("firecrawl-actions-ok");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "fails the scrape when an action cannot complete",
    async () => {
      const raw = await scrapeRaw(
        {
          url: INTERACT_URL,
          timeout: 15000,
          actions: [{ type: "click", selector: "#does-not-exist" }],
        },
        identity,
      );

      expect(raw.statusCode).not.toBe(200);
      expect(raw.body.success).toBe(false);
      expect(raw.body.code).toBe("SCRAPE_ACTION_ERROR");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "takes a screenshot for the screenshot format",
    async () => {
      const doc = await scrape(
        {
          url: INTERACT_URL,
          formats: [{ type: "screenshot", fullPage: true, quality: 60 }],
        },
        identity,
      );

      expect(doc.screenshot).toMatch(/^data:image\/jpeg;base64,/);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "emulates a phone when mobile is set",
    async () => {
      const doc = await scrape(
        { url: INTERACT_URL, formats: ["markdown"], mobile: true },
        identity,
      );

      expect(doc.markdown).toContain("Viewport width: 390");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "captures the API calls a page makes",
    async () => {
      const doc = await scrape(
        {
          url: INTERACT_URL,
          formats: ["markdown", { type: "network" }],
          waitFor: 1000,
        },
        identity,
      );

      const call = doc.network?.requests.find(r =>
        r.url.includes("/example.json?source=xray"),
      );
      expect(call).toBeDefined();
      expect(call?.method).toBe("GET");
      expect(call?.status).toBe(200);
      expect(call?.resourceType).toBe("fetch");
      expect(call?.json).toMatchObject({ id: 1, title: "delectus aut autem" });
      expect(doc.network?.truncated).toBe(false);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "filters captured calls by urlPattern",
    async () => {
      const doc = await scrape(
        {
          url: INTERACT_URL,
          formats: [{ type: "network", urlPattern: "no-such-endpoint" }],
          waitFor: 1000,
        },
        identity,
      );

      expect(doc.network).toEqual({ requests: [], total: 0, truncated: false });
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "presents the locale and timezone of the requested country",
    async () => {
      const doc = await scrape(
        {
          url: INTERACT_URL,
          formats: ["markdown"],
          location: { country: "DE" },
        },
        identity,
      );

      expect(doc.markdown).toContain("Language: de-DE");
      expect(doc.markdown).toContain("Timezone: Europe/Berlin");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "hides automation markers for a stealth scrape and only then",
    async () => {
      const stealth = await scrape(
        { url: INTERACT_URL, formats: ["markdown"], proxy: "stealth" },
        identity,
      );
      expect(stealth.markdown).toContain("Webdriver: false");
      expect(stealth.markdown).toContain("Headless: false");
      expect(stealth.metadata.proxyUsed).toBe("stealth");

      const basic = await scrape(
        { url: INTERACT_URL, formats: ["markdown"], proxy: "basic" },
        identity,
      );
      expect(basic.markdown).toContain("Webdriver: true");
      expect(basic.metadata.proxyUsed).toBe("basic");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "extracts branding without leaking the scan into action results",
    async () => {
      const doc = await scrape(
        { url: TEST_SUITE_WEBSITE, formats: ["branding"] },
        identity,
      );

      expect(doc.branding).toBeDefined();
      expect(doc.branding?.colors).toBeDefined();
      expect(doc.branding?.fonts?.length ?? 0).toBeGreaterThan(0);
      expect(doc.actions?.javascriptReturns ?? []).toEqual([]);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_FETCH_ONLY)(
    "warns when no browser engine can capture the network",
    async () => {
      const doc = await scrape(
        { url: INTERACT_URL, formats: ["markdown", { type: "network" }] },
        identity,
      );

      expect(doc.network).toBeUndefined();
      expect(doc.warning).toContain("Network capture needs a browser engine");
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "matches urlPattern as text with * wildcards, not as a regex",
    async () => {
      const capture = async (urlPattern: string) =>
        (
          await scrape(
            {
              url: INTERACT_URL,
              formats: [{ type: "network", urlPattern }],
              waitFor: 1000,
            },
            identity,
          )
        ).network;

      expect((await capture("example.json*source=xray"))?.total).toBe(1);
      // A pattern built to make a regex engine backtrack is just text here.
      expect((await capture("^(a+)+$"))?.total).toBe(0);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_BROWSER)(
    "ends a scrape whose action never finishes and keeps serving",
    async () => {
      const stuck = await scrapeRaw(
        {
          url: INTERACT_URL,
          timeout: 10000,
          actions: [{ type: "executeJavascript", script: "while(true){}" }],
        },
        identity,
      );
      expect(stuck.statusCode).not.toBe(200);
      expect(stuck.body.success).toBe(false);

      const next = await scrape(
        { url: INTERACT_URL, formats: ["markdown"] },
        identity,
      );
      expect(next.markdown).toContain("Interaction Test");
    },
    scrapeTimeout,
  );

  it("rejects an oversized network urlPattern", async () => {
    const raw = await scrapeRaw(
      {
        url: INTERACT_URL,
        formats: [{ type: "network", urlPattern: "a".repeat(501) }],
      },
      identity,
    );

    expect(raw.statusCode).toBe(400);
    expect(raw.body.success).toBe(false);
  });
});
