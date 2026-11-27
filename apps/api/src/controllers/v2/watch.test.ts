import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Watch } from "../../lib/watch-store";

const mockGetWatch = vi.fn();
const mockSaveWatch = vi.fn();
const mockClearWatchExtractedState = vi.fn();

vi.mock("../../lib/snapshot-store", () => ({
  snapshotStoreEnabled: true,
}));

vi.mock("../../lib/watch-store", () => ({
  getWatch: (...args: unknown[]) => mockGetWatch(...args),
  saveWatch: (...args: unknown[]) => mockSaveWatch(...args),
  clearWatchExtractedState: (...args: unknown[]) =>
    mockClearWatchExtractedState(...args),
  countWatches: vi.fn().mockResolvedValue(0),
  deleteWatch: vi.fn(),
  listWatchRuns: vi.fn(),
  listWatches: vi.fn(),
  newWatchId: vi.fn(() => WATCH_ID),
}));

vi.mock("../../services/monitoring/cron", () => ({
  getNextMonitorRunAt: vi.fn(
    (_cron: string, from: Date = new Date("2026-12-01T00:00:00.000Z")) =>
      new Date(from.getTime() + 86_400_000),
  ),
}));

vi.mock("../../services/watch/runner", () => ({
  nextRunAt: vi.fn(
    (_schedule: unknown, from: Date = new Date("2026-12-01T00:00:00.000Z")) =>
      new Date(from.getTime() + 86_400_000),
  ),
  runWatch: vi.fn(),
}));

import { watchCreateController, watchUpdateController } from "./watch";

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const WATCH_ID = "11111111-1111-4111-8111-111111111111";

function baseWatch(): Watch {
  return {
    id: WATCH_ID,
    url: "https://example.com",
    schedule: { cron: "0 3 * * *", timezone: "UTC" },
    enabled: true,
    webhook: null,
    notifyOn: ["changed"],
    extractRules: {
      price: { selector: ".price", transform: "number" },
    },
    createdAt: "2026-11-01T00:00:00.000Z",
    lastRunAt: "2026-11-02T00:00:00.000Z",
    lastStatus: "same",
    nextRunAt: "2026-11-03T00:00:00.000Z",
  };
}

describe("watchUpdateController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWatch.mockResolvedValue(baseWatch());
    mockSaveWatch.mockResolvedValue(undefined);
    mockClearWatchExtractedState.mockResolvedValue(undefined);
  });

  it("clears saved extracted state when extractRules changes", async () => {
    const req: any = {
      auth: { team_id: "team-1" },
      params: { watchId: WATCH_ID },
      body: {
        extractRules: {
          title: { selector: "h1" },
        },
      },
    };
    const res = makeRes();

    await watchUpdateController(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockSaveWatch).toHaveBeenCalledTimes(1);
    expect(mockClearWatchExtractedState).toHaveBeenCalledWith(
      "team-1",
      WATCH_ID,
    );
  });

  it("clears saved extracted state when extractRules is cleared to null", async () => {
    const req: any = {
      auth: { team_id: "team-1" },
      params: { watchId: WATCH_ID },
      body: {
        extractRules: null,
      },
    };
    const res = makeRes();

    await watchUpdateController(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockClearWatchExtractedState).toHaveBeenCalledWith(
      "team-1",
      WATCH_ID,
    );
  });

  it("does not clear saved extracted state when extractRules is unchanged or omitted", async () => {
    const reqOmitted: any = {
      auth: { team_id: "team-1" },
      params: { watchId: WATCH_ID },
      body: { enabled: false },
    };
    const res1 = makeRes();
    await watchUpdateController(reqOmitted, res1);
    expect(res1.statusCode).toBe(200);
    expect(mockClearWatchExtractedState).not.toHaveBeenCalled();

    const reqSame: any = {
      auth: { team_id: "team-1" },
      params: { watchId: WATCH_ID },
      body: {
        extractRules: {
          price: { selector: ".price", transform: "number" },
        },
      },
    };
    const res2 = makeRes();
    await watchUpdateController(reqSame, res2);
    expect(res2.statusCode).toBe(200);
    expect(mockClearWatchExtractedState).not.toHaveBeenCalled();
  });

  it("accepts SDK origin on create and update, and rejects origin-only updates", async () => {
    const createReq: any = {
      auth: { team_id: "team-1" },
      body: {
        url: "https://example.com",
        schedule: { cron: "0 3 * * *" },
        origin: "js-sdk@4.49.1",
      },
    };
    const createRes = makeRes();
    await watchCreateController(createReq, createRes);
    expect(createRes.statusCode).toBe(200);
    expect(createRes.body.watch.origin).toBeUndefined();

    const updateReq: any = {
      auth: { team_id: "team-1" },
      params: { watchId: WATCH_ID },
      body: { enabled: false, origin: "python-sdk@4.0.0" },
    };
    const updateRes = makeRes();
    await watchUpdateController(updateReq, updateRes);
    expect(updateRes.statusCode).toBe(200);

    const emptyUpdateReq: any = {
      auth: { team_id: "team-1" },
      params: { watchId: WATCH_ID },
      body: { origin: "js-sdk@4.49.1" },
    };
    const emptyUpdateRes = makeRes();
    await watchUpdateController(emptyUpdateReq, emptyUpdateRes);
    expect(emptyUpdateRes.statusCode).toBe(400);
  });

  it("rejects specifying both focus and extractRules on create", async () => {
    const req: any = {
      auth: { team_id: "team-1" },
      body: {
        url: "https://example.com",
        schedule: { cron: "0 3 * * *" },
        focus: { query: "pricing" },
        extractRules: { price: ".price" },
      },
    };
    const res = makeRes();
    await watchCreateController(req, res);
    expect(res.statusCode).toBe(400);
  });
});
