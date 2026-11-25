import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { config } from "../../../config";
import { HAS_PROXY, itIf, TEST_SELF_HOST } from "../lib";
import request, { Identity, idmux, scrapeTimeout, TEST_API_URL } from "./lib";

// Watches re-scrape a URL on a schedule and call a webhook when it changes.
// Both the watched page and the webhook receiver are served from this process.
const LOCAL_WATCH = TEST_SELF_HOST && !HAS_PROXY;
// The schedule test needs the server to allow and poll short intervals.
const FAST_SCHEDULE =
  LOCAL_WATCH &&
  config.WATCH_MIN_INTERVAL_SECONDS <= 5 &&
  config.WATCH_POLL_INTERVAL_MS <= 5000;

type Delivery = { body: any; rawBody: string; signature: string | undefined };

let identity: Identity;
let server: http.Server;
let base: string;
const prices = new Map<string, string>();
const noise = new Map<string, string>();
const flakyHookFailsLeft = new Map<string, number>();
const deliveries = new Map<string, Delivery[]>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const api = (method: "get" | "post" | "patch" | "delete", path: string) =>
  request(TEST_API_URL)
    [method](path)
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

async function waitForDeliveries(
  hook: string,
  count: number,
  withinMs: number,
) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if ((deliveries.get(hook)?.length ?? 0) >= count) break;
    await sleep(500);
  }
  return deliveries.get(hook) ?? [];
}

beforeAll(async () => {
  identity = await idmux({
    name: "watch",
    concurrency: 20,
    credits: 1000000,
  });

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const key = url.pathname.split("/")[2] ?? "";
    if (url.pathname.startsWith("/hook/")) {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const failsLeft = flakyHookFailsLeft.get(key) ?? 0;
        if (failsLeft > 0) {
          flakyHookFailsLeft.set(key, failsLeft - 1);
          res.writeHead(500).end("temporary failure");
          return;
        }
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const list = deliveries.get(key) ?? [];
        list.push({
          body: JSON.parse(rawBody),
          rawBody,
          signature: req.headers["x-firecrawl-signature"] as string | undefined,
        });
        deliveries.set(key, list);
        res.writeHead(200).end("ok");
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>Plan</title></head><body><main>` +
        `<h1>Plan</h1><p>The plan costs <span class="price">${prices.get(key) ?? "$10"}</span> per month.</p>` +
        `<footer class="noise">${noise.get(key) ?? "banner-1"}</footer>` +
        `</main></body></html>`,
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 10000);

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe("Watches", () => {
  itIf(LOCAL_WATCH)(
    "detects a change on a manual run and calls the signed webhook",
    async () => {
      const key = crypto.randomUUID();
      const secret = "watch-test-secret";
      const created = await api("post", "/v2/watch").send({
        url: `${base}/page/${key}`,
        schedule: { cron: "0 3 * * *" },
        webhook: { url: `${base}/hook/${key}`, secret },
      });
      expect(created.statusCode).toBe(200);
      const watch = created.body.watch;
      expect(watch.nextRunAt).toEqual(expect.any(String));
      // The secret is never returned.
      expect(watch.webhook).toEqual({
        url: `${base}/hook/${key}`,
        hasSecret: true,
      });

      const first = await api("post", `/v2/watch/${watch.id}/run`).send();
      expect(first.statusCode).toBe(200);
      expect(first.body.run.changeStatus).toBe("new");
      // "new" is not in the default notifyOn.
      expect(first.body.run.webhook).toBeNull();

      const same = await api("post", `/v2/watch/${watch.id}/run`).send();
      expect(same.body.run.changeStatus).toBe("same");
      expect(deliveries.get(key)).toBeUndefined();

      prices.set(key, "$25");
      const changed = await api("post", `/v2/watch/${watch.id}/run`).send();
      expect(changed.body.run.changeStatus).toBe("changed");
      expect(changed.body.run.diff).toContain("$25");
      expect(changed.body.run.webhook).toMatchObject({ delivered: true });

      const [delivery] = deliveries.get(key) ?? [];
      expect(delivery.body).toMatchObject({
        type: "watch.changed",
        watchId: watch.id,
        url: `${base}/page/${key}`,
        changeStatus: "changed",
      });
      expect(delivery.body.diff).toContain("$10");
      expect(delivery.signature).toBe(
        "sha256=" +
          crypto
            .createHmac("sha256", secret)
            .update(delivery.rawBody)
            .digest("hex"),
      );

      const runs = await api("get", `/v2/watch/${watch.id}/runs`);
      expect(
        runs.body.runs.map((r: { changeStatus: string }) => r.changeStatus),
      ).toEqual(["changed", "same", "new"]);

      const fetched = await api("get", `/v2/watch/${watch.id}`);
      expect(fetched.body.watch.lastStatus).toBe("changed");

      const listed = await api("get", "/v2/watch");
      expect(
        listed.body.watches.some((w: { id: string }) => w.id === watch.id),
      ).toBe(true);

      const deleted = await api("delete", `/v2/watch/${watch.id}`);
      expect(deleted.statusCode).toBe(200);
      const gone = await api("get", `/v2/watch/${watch.id}`);
      expect(gone.statusCode).toBe(404);
    },
    5 * scrapeTimeout,
  );

  itIf(FAST_SCHEDULE)(
    "runs on its schedule without being asked",
    async () => {
      const key = crypto.randomUUID();
      const created = await api("post", "/v2/watch").send({
        url: `${base}/page/${key}`,
        schedule: { everySeconds: config.WATCH_MIN_INTERVAL_SECONDS },
        webhook: { url: `${base}/hook/${key}` },
        notifyOn: ["new", "changed"],
      });
      expect(created.statusCode).toBe(200);
      const id = created.body.watch.id;

      try {
        const [first] = await waitForDeliveries(key, 1, 90000);
        expect(first?.body.type).toBe("watch.new");

        prices.set(key, "$40");
        const all = await waitForDeliveries(key, 2, 90000);
        expect(all[1]?.body.type).toBe("watch.changed");
        expect(all[1]?.body.diff).toContain("$40");

        const runs = await api("get", `/v2/watch/${id}/runs`);
        expect(
          runs.body.runs.every(
            (r: { trigger: string }) => r.trigger === "schedule",
          ),
        ).toBe(true);
      } finally {
        await api("delete", `/v2/watch/${id}`);
      }
    },
    5 * scrapeTimeout,
  );

  itIf(LOCAL_WATCH)(
    "rejects bad schedules and URLs, and unknown watches",
    async () => {
      const bad = async (body: object) =>
        (await api("post", "/v2/watch").send(body)).statusCode;

      expect(await bad({ url: `${base}/page/x`, schedule: {} })).toBe(400);
      expect(
        await bad({ url: `${base}/page/x`, schedule: { cron: "not a cron" } }),
      ).toBe(400);
      expect(
        await bad({ url: `${base}/page/x`, schedule: { everySeconds: 0 } }),
      ).toBe(400);
      expect(
        await bad({
          url: "ftp://example.com",
          schedule: { cron: "0 3 * * *" },
        }),
      ).toBe(400);
      expect(
        await bad({
          url: `${base}/page/x`,
          schedule: { cron: "0 3 * * *" },
          webhook: { url: "file:///etc/passwd" },
        }),
      ).toBe(400);

      const missing = crypto.randomUUID();
      expect((await api("get", `/v2/watch/${missing}`)).statusCode).toBe(404);
      expect(
        (await api("post", `/v2/watch/${missing}/run`).send()).statusCode,
      ).toBe(404);
      expect((await api("delete", `/v2/watch/${missing}`)).statusCode).toBe(
        404,
      );
      expect((await api("get", "/v2/watch/not-a-uuid")).statusCode).toBe(400);
    },
    scrapeTimeout,
  );

  itIf(LOCAL_WATCH)(
    "ignores surrounding noise with extractRules, emits fieldChanges, retries flaky webhooks, and supports PATCH",
    async () => {
      const key = crypto.randomUUID();
      prices.set(key, "$10");
      noise.set(key, "banner-v1");

      const created = await api("post", "/v2/watch").send({
        url: `${base}/page/${key}`,
        schedule: { cron: "0 3 * * *" },
        webhook: { url: `${base}/hook/${key}`, secret: "keep-me" },
        extractRules: {
          price: { selector: ".price", transform: "number" },
        },
      });
      expect(created.statusCode).toBe(200);
      const id = created.body.watch.id as string;

      try {
        // First run establishes baseline.
        const r1 = await api("post", `/v2/watch/${id}/run`).send();
        expect(r1.statusCode).toBe(200);
        expect(r1.body.run.changeStatus).toBe("new");
        expect(r1.body.run.extracted).toEqual({ price: 10 });

        // Changing unrelated footer noise does NOT trigger a change.
        noise.set(key, "banner-v2-completely-different-timestamp");
        const r2 = await api("post", `/v2/watch/${id}/run`).send();
        expect(r2.body.run.changeStatus).toBe("same");
        expect(r2.body.run.fieldChanges).toEqual([]);
        expect(deliveries.get(key)).toBeUndefined();

        // Changing the tracked price triggers a change with fieldChanges, and retries a 500 webhook.
        prices.set(key, "$29.50");
        flakyHookFailsLeft.set(key, 1);
        const r3 = await api("post", `/v2/watch/${id}/run`).send();
        expect(r3.body.run.changeStatus).toBe("changed");
        expect(r3.body.run.extracted).toEqual({ price: 29.5 });
        expect(r3.body.run.fieldChanges).toEqual([
          { path: "price", before: 10, after: 29.5 },
        ]);
        expect(r3.body.run.webhook).toMatchObject({
          delivered: true,
          statusCode: 200,
          attempts: 2,
        });

        const sent = deliveries.get(key) ?? [];
        expect(sent).toHaveLength(1);
        expect(sent[0].body.fieldChanges).toEqual([
          { path: "price", before: 10, after: 29.5 },
        ]);

        // PATCH pauses the watch and preserves the webhook secret when updating URL.
        const patched = await api("patch", `/v2/watch/${id}`).send({
          enabled: false,
          webhook: { url: `${base}/hook/${key}` },
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.body.watch.enabled).toBe(false);
        expect(patched.body.watch.webhook.hasSecret).toBe(true);
      } finally {
        await api("delete", `/v2/watch/${id}`);
      }
    },
    3 * scrapeTimeout,
  );

  itIf(LOCAL_WATCH)(
    "resets extracted baseline when extractRules are updated via PATCH",
    async () => {
      const key = crypto.randomUUID();
      prices.set(key, "$10");
      noise.set(key, "banner-v1");

      const created = await api("post", "/v2/watch").send({
        url: `${base}/page/${key}`,
        schedule: { cron: "0 3 * * *" },
        webhook: { url: `${base}/hook/${key}` },
        extractRules: {
          price: { selector: ".price", transform: "number" },
        },
      });
      expect(created.statusCode).toBe(200);
      const id = created.body.watch.id as string;

      try {
        // Establish baseline with initial extractRules.
        const r1 = await api("post", `/v2/watch/${id}/run`).send();
        expect(r1.statusCode).toBe(200);
        expect(r1.body.run.changeStatus).toBe("new");
        expect(r1.body.run.extracted).toEqual({ price: 10 });

        // Update extractRules without changing the page itself.
        const patched = await api("patch", `/v2/watch/${id}`).send({
          extractRules: {
            footer: { selector: ".noise" },
          },
        });
        expect(patched.statusCode).toBe(200);

        // Next run must establish a fresh baseline ("new") rather than diffing
        // against the previous rules' extracted state and reporting "changed".
        const r2 = await api("post", `/v2/watch/${id}/run`).send();
        expect(r2.statusCode).toBe(200);
        expect(r2.body.run.changeStatus).toBe("new");
        expect(r2.body.run.fieldChanges).toEqual([]);
        expect(r2.body.run.extracted).toEqual({ footer: "banner-v1" });
        expect(deliveries.get(key)).toBeUndefined();

        // Subsequent run with unchanged page reports "same".
        const r3 = await api("post", `/v2/watch/${id}/run`).send();
        expect(r3.statusCode).toBe(200);
        expect(r3.body.run.changeStatus).toBe("same");
        expect(r3.body.run.fieldChanges).toEqual([]);
      } finally {
        await api("delete", `/v2/watch/${id}`);
      }
    },
    3 * scrapeTimeout,
  );
});
