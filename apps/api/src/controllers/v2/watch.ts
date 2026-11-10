import type { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { URL as urlSchema, type RequestWithAuth } from "./types";
import { snapshotStoreEnabled } from "../../lib/snapshot-store";
import {
  type Watch,
  countWatches,
  deleteWatch,
  getWatch,
  listWatchRuns,
  listWatches,
  newWatchId,
  saveWatch,
} from "../../lib/watch-store";
import { getNextMonitorRunAt } from "../../services/monitoring/cron";
import { nextRunAt, runWatch } from "../../services/watch/runner";

const UNAVAILABLE =
  "Watches need the local snapshot store, which is not enabled on this deployment. It is on by default for self-hosted instances without DB authentication.";

const scheduleSchema = z.union([
  z.strictObject({
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(64).default("UTC"),
  }),
  z.strictObject({
    everySeconds: z
      .int()
      .min(config.WATCH_MIN_INTERVAL_SECONDS)
      .max(365 * 86_400),
  }),
]);

const createSchema = z.strictObject({
  url: urlSchema,
  schedule: scheduleSchema,
  webhook: z
    .strictObject({
      url: z.url().regex(/^https?:\/\//i, "Webhook URL must be http or https"),
      headers: z.record(z.string(), z.string()).optional(),
      // Signs each delivery: X-Firecrawl-Signature: sha256=<hmac of the body>.
      secret: z.string().min(1).max(256).optional(),
    })
    .optional(),
  notifyOn: z
    .enum(["new", "same", "changed", "removed"])
    .array()
    .min(1)
    .default(["changed", "removed"]),
});

const idSchema = z.uuid();

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function issues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/** A watch as returned to callers: the webhook secret is write-only. */
function publicWatch(watch: Watch) {
  return {
    ...watch,
    webhook: watch.webhook
      ? {
          url: watch.webhook.url,
          headers: watch.webhook.headers,
          hasSecret: watch.webhook.secret !== undefined,
        }
      : null,
  };
}

type WatchRequest = RequestWithAuth<{ watchId: string }, any, any>;

/** POST /v2/watch */
export async function watchCreateController(
  req: RequestWithAuth<{}, any, unknown>,
  res: Response,
) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return fail(res, 400, issues(body.error));

  const now = new Date();
  let firstRun: Date;
  try {
    firstRun = nextRunAt(body.data.schedule, now);
    if ("cron" in body.data.schedule) {
      const { cron, timezone } = body.data.schedule;
      const second = getNextMonitorRunAt(cron, firstRun, timezone);
      const minimumMs = config.WATCH_MIN_INTERVAL_SECONDS * 1000;
      if (second.getTime() - firstRun.getTime() < minimumMs) {
        return fail(
          res,
          400,
          `schedule: must not run more often than every ${config.WATCH_MIN_INTERVAL_SECONDS} seconds`,
        );
      }
    }
  } catch (error) {
    return fail(
      res,
      400,
      "schedule: " + (error instanceof Error ? error.message : "invalid"),
    );
  }

  if ((await countWatches(req.auth.team_id)) >= config.WATCH_MAX_PER_TEAM) {
    return fail(
      res,
      400,
      `Watch limit reached (${config.WATCH_MAX_PER_TEAM}). Delete a watch or raise WATCH_MAX_PER_TEAM.`,
    );
  }

  const watch: Watch = {
    id: newWatchId(),
    url: body.data.url,
    schedule: body.data.schedule,
    webhook: body.data.webhook ?? null,
    notifyOn: body.data.notifyOn,
    createdAt: now.toISOString(),
    lastRunAt: null,
    lastStatus: null,
    nextRunAt: firstRun.toISOString(),
  };
  await saveWatch(req.auth.team_id, watch);
  return res.status(200).json({ success: true, watch: publicWatch(watch) });
}

/** GET /v2/watch */
export async function watchListController(
  req: RequestWithAuth<{}, any, undefined>,
  res: Response,
) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  const watches = await listWatches(req.auth.team_id);
  return res
    .status(200)
    .json({ success: true, watches: watches.map(publicWatch) });
}

/** GET /v2/watch/:watchId */
export async function watchGetController(req: WatchRequest, res: Response) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  if (!idSchema.safeParse(req.params.watchId).success) {
    return fail(res, 400, "Invalid watch ID.");
  }
  const watch = await getWatch(req.auth.team_id, req.params.watchId);
  if (!watch) return fail(res, 404, "Watch not found.");
  return res.status(200).json({ success: true, watch: publicWatch(watch) });
}

/** DELETE /v2/watch/:watchId */
export async function watchDeleteController(req: WatchRequest, res: Response) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  if (!idSchema.safeParse(req.params.watchId).success) {
    return fail(res, 400, "Invalid watch ID.");
  }
  const deleted = await deleteWatch(req.auth.team_id, req.params.watchId);
  if (!deleted) return fail(res, 404, "Watch not found.");
  return res.status(200).json({ success: true });
}

/** POST /v2/watch/:watchId/run — run now and return the result. */
export async function watchRunController(req: WatchRequest, res: Response) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  if (!idSchema.safeParse(req.params.watchId).success) {
    return fail(res, 400, "Invalid watch ID.");
  }
  const run = await runWatch(req.auth.team_id, req.params.watchId, "manual");
  if (run === null) return fail(res, 404, "Watch not found.");
  if (run === "busy") {
    return fail(res, 409, "This watch is already running.");
  }
  return res.status(200).json({ success: true, run });
}

/** GET /v2/watch/:watchId/runs — recent runs, newest first. */
export async function watchRunsController(req: WatchRequest, res: Response) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  if (!idSchema.safeParse(req.params.watchId).success) {
    return fail(res, 400, "Invalid watch ID.");
  }
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .safeParse(req.query.limit);
  if (!limit.success) return fail(res, 400, "limit: " + issues(limit.error));
  if (!(await getWatch(req.auth.team_id, req.params.watchId))) {
    return fail(res, 404, "Watch not found.");
  }
  const runs = await listWatchRuns(
    req.auth.team_id,
    req.params.watchId,
    limit.data,
  );
  return res.status(200).json({ success: true, runs });
}
