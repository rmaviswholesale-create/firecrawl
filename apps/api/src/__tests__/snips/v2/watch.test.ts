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
const deliveries = new Map<string, Delivery[]>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const api = (method: "get" | "post" | "delete", path: string) =>
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
        `<h1>Plan</h1><p>The plan costs ${prices.get(key) ?? "$10"} per month.</p>` +
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
});
