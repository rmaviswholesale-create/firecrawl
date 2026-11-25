import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { HAS_PROXY, itIf, TEST_SELF_HOST } from "../lib";
import request, { Identity, idmux, scrape, scrapeTimeout, TEST_API_URL } from "./lib";

const LOCAL_PROFILE = TEST_SELF_HOST && !HAS_PROXY;

let identity: Identity;
let server: http.Server;
let base: string;

const api = (method: "get" | "delete", path: string) =>
  request(TEST_API_URL)
    [method](path)
    .set("Authorization", `Bearer ${identity.apiKey}`)
    .set("Content-Type", "application/json");

beforeAll(async () => {
  identity = await idmux({
    name: "local-profiles",
    concurrency: 20,
    credits: 1000000,
  });

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/login") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "session_token=secret-42; Path=/; HttpOnly",
      });
      res.end(
        `<!doctype html><html><body>` +
          `<script>localStorage.setItem("user_role", "admin");</script>` +
          `<p>Logged in</p></body></html>`,
      );
      return;
    }

    const cookie = req.headers.cookie ?? "";
    const authed = cookie.includes("session_token=secret-42");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body>` +
        `<p id="auth">${authed ? "AUTHENTICATED" : "ANONYMOUS"}</p>` +
        `<p id="role"></p>` +
        `<script>document.getElementById("role").textContent = localStorage.getItem("user_role") || "none";</script>` +
        `</body></html>`,
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 10000);

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

describe("Local browser profiles", () => {
  itIf(LOCAL_PROFILE)(
    "persists cookies and localStorage across scrapes and supports /v2/profiles CRUD",
    async () => {
      const profileName = "test-profile-" + crypto.randomUUID().slice(0, 8);

      // 1. Login scrape saves cookies + localStorage into the named profile.
      const loginDoc = await scrape(
        {
          url: `${base}/login`,
          formats: ["markdown"],
          profile: { name: profileName, saveChanges: true },
        },
        identity,
      );
      expect(loginDoc.markdown).toContain("Logged in");

      // 2. Profile appears in GET /v2/profiles and GET /v2/profiles/:name.
      const list = await api("get", "/v2/profiles");
      expect(list.statusCode).toBe(200);
      expect(
        list.body.profiles.some((p: any) => p.name === profileName),
      ).toBe(true);

      const single = await api("get", `/v2/profiles/${profileName}`);
      expect(single.statusCode).toBe(200);
      expect(single.body.profile.name).toBe(profileName);
      expect(single.body.profile.cookieCount).toBeGreaterThanOrEqual(1);
      expect(single.body.profile.originCount).toBeGreaterThanOrEqual(1);

      // 3. Subsequent scrape reuses the persisted HttpOnly cookie + localStorage.
      const authedDoc = await scrape(
        {
          url: `${base}/dashboard`,
          formats: ["markdown"],
          profile: { name: profileName, saveChanges: false },
        },
        identity,
      );
      expect(authedDoc.markdown).toContain("AUTHENTICATED");
      expect(authedDoc.markdown).toContain("admin");

      // 4. Deleting the profile clears the saved session.
      const del = await api("delete", `/v2/profiles/${profileName}`);
      expect(del.statusCode).toBe(200);

      const missing = await api("get", `/v2/profiles/${profileName}`);
      expect(missing.statusCode).toBe(404);

      const anonDoc = await scrape(
        {
          url: `${base}/dashboard`,
          formats: ["markdown"],
          profile: { name: profileName, saveChanges: false },
        },
        identity,
      );
      expect(anonDoc.markdown).toContain("ANONYMOUS");
      expect(anonDoc.markdown).toContain("none");
    },
    scrapeTimeout * 3,
  );
});
