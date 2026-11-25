import { describe, expect, it, vi } from "vitest";
import FirecrawlClient from "../../../v2/client";

function makeClientWithMocks() {
  const client = new FirecrawlClient({ apiKey: "fc-test", apiUrl: "https://api.example.com" });
  const http = (client as any).http;
  return { client, http };
}

describe("v2 self-host parity methods", () => {
  it("calls watch endpoints correctly", async () => {
    const { client, http } = makeClientWithMocks();
    const watch = { id: "w-1", url: "https://example.com" };
    const run = { id: "r-1", changeStatus: "new" };

    const postSpy = vi.spyOn(http, "post").mockImplementation(async (url: string) => {
      if (url === "/v2/watch") return { status: 200, data: { success: true, watch } };
      return { status: 200, data: { success: true, run } };
    });
    const getSpy = vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url === "/v2/watch") return { status: 200, data: { success: true, watches: [watch] } };
      if (url.endsWith("/runs?limit=5")) return { status: 200, data: { success: true, runs: [run] } };
      return { status: 200, data: { success: true, watch } };
    });
    const patchSpy = vi.spyOn(http, "patch").mockResolvedValue({
      status: 200,
      data: { success: true, watch: { ...watch, enabled: false } },
    });
    const delSpy = vi.spyOn(http, "delete").mockResolvedValue({
      status: 200,
      data: { success: true },
    });

    expect(await client.createWatch({ url: "https://example.com", schedule: { cron: "0 3 * * *" } })).toEqual(watch);
    expect(await client.listWatches()).toEqual([watch]);
    expect(await client.getWatch("w-1")).toEqual(watch);
    expect(await client.updateWatch("w-1", { enabled: false })).toMatchObject({ enabled: false });
    expect(await client.runWatch("w-1")).toEqual(run);
    expect(await client.listWatchRuns("w-1", 5)).toEqual([run]);
    expect(await client.deleteWatch("w-1")).toEqual({ success: true });

    expect(postSpy).toHaveBeenCalledWith("/v2/watch", expect.any(Object));
    expect(patchSpy).toHaveBeenCalledWith("/v2/watch/w-1", { enabled: false });
    expect(getSpy).toHaveBeenCalledWith("/v2/watch/w-1/runs?limit=5");
    expect(delSpy).toHaveBeenCalledWith("/v2/watch/w-1");
  });

  it("calls profiles and snapshots endpoints correctly", async () => {
    const { client, http } = makeClientWithMocks();
    const profile = { name: "p1", cookieCount: 2, originCount: 1, updatedAt: "2026-11-25T00:00:00Z" };
    const snap = { id: "s1", url: "https://example.com", tag: null, capturedAt: "2026-11-25T00:00:00Z", statusCode: 200, contentHash: "abc", markdown: "# hi" };

    const getSpy = vi.spyOn(http, "get").mockImplementation(async (url: string) => {
      if (url === "/v2/profiles") return { status: 200, data: { success: true, profiles: [profile] } };
      if (url === "/v2/profiles/p1") return { status: 200, data: { success: true, profile } };
      if (url.startsWith("/v2/snapshots/diff")) return { status: 200, data: { success: true, changeStatus: "changed", from: snap, to: snap } };
      if (url.startsWith("/v2/snapshots?")) return { status: 200, data: { success: true, snapshots: [snap] } };
      return { status: 200, data: { success: true, snapshot: snap } };
    });
    const delSpy = vi.spyOn(http, "delete").mockResolvedValue({ status: 200, data: { success: true } });

    expect(await client.listProfiles()).toEqual([profile]);
    expect(await client.getProfile("p1")).toEqual(profile);
    expect(await client.deleteProfile("p1")).toEqual({ success: true });
    expect(await client.listSnapshots({ url: "https://example.com", limit: 10 })).toEqual([snap]);
    expect(await client.getSnapshot("s1")).toEqual(snap);
    expect(await client.diffSnapshots("s1", "s2")).toMatchObject({ changeStatus: "changed" });

    expect(getSpy).toHaveBeenCalledWith("/v2/profiles/p1");
    expect(delSpy).toHaveBeenCalledWith("/v2/profiles/p1");
    expect(getSpy).toHaveBeenCalledWith("/v2/snapshots/diff?from=s1&to=s2");
  });
});
