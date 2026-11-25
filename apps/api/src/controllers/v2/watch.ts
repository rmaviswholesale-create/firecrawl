import type { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import {
  URL as urlSchema,
  extractRuleSchema,
  scrapeOptions as fullScrapeOptionsSchema,
  type RequestWithAuth,
} from "./types";
import { browserProfileNameSchema } from "../../lib/browser-profiles";
import { snapshotStoreEnabled } from "../../lib/snapshot-store";
import {
  type Watch,
  type WatchSchedule,
  clearWatchExtractedState,
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

const webhookSchema = z.strictObject({
  url: z.url().regex(/^https?:\/\//i, "Webhook URL must be http or https"),
  headers: z.record(z.string(), z.string()).optional(),
  // Signs each delivery: X-Firecrawl-Signature: sha256=<hmac of the body>.
  secret: z.string().min(1).max(256).optional(),
});

const watchScrapeOptionsSchema = z
  .strictObject({
    waitFor: z.int().min(0).max(60_000).optional(),
    mobile: z.boolean().optional(),
    location: z
      .strictObject({
        country: z.string().min(2).max(10).optional(),
        languages: z.array(z.string().min(1).max(32)).max(5).optional(),
      })
      .optional(),
    proxy: z.enum(["basic", "stealth", "enhanced", "auto"]).optional(),
    actions: z.array(z.unknown()).max(50).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    includeTags: z.array(z.string().min(1).max(200)).max(50).optional(),
    excludeTags: z.array(z.string().min(1).max(200)).max(50).optional(),
    onlyMainContent: z.boolean().optional(),
    profile: z
      .strictObject({
        name: browserProfileNameSchema,
        saveChanges: z.boolean().default(false),
      })
      .optional(),
    timeout: z.int().min(1000).max(300_000).optional(),
  })
  .superRefine((val, ctx) => {
    // Validate actions & full option compatibility against the real scrapeOptions schema.
    const check = fullScrapeOptionsSchema.safeParse({
      ...val,
      formats: ["markdown"],
    });
    if (!check.success) {
      for (const issue of check.error.issues) {
        ctx.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
  });

const watchFocusSchema = z.strictObject({
  query: z.string().min(1).max(2000),
  maxTokens: z.int().min(50).max(200_000).optional(),
});

const extractRulesSchema = z
  .record(z.string().min(1).max(128), extractRuleSchema)
  .refine(
    rules => Object.keys(rules).length > 0 && Object.keys(rules).length <= 100,
    "extractRules must contain between 1 and 100 fields",
  );

const createSchema = z.strictObject({
  url: urlSchema,
  schedule: scheduleSchema,
  enabled: z.boolean().default(true),
  webhook: webhookSchema.optional(),
  notifyOn: z
    .enum(["new", "same", "changed", "removed"])
    .array()
    .min(1)
    .default(["changed", "removed"]),
  scrapeOptions: watchScrapeOptionsSchema.optional(),
  focus: watchFocusSchema.optional(),
  extractRules: extractRulesSchema.optional(),
});

const updateSchema = z
  .strictObject({
    schedule: scheduleSchema.optional(),
    enabled: z.boolean().optional(),
    webhook: webhookSchema.nullable().optional(),
    notifyOn: z
      .enum(["new", "same", "changed", "removed"])
      .array()
      .min(1)
      .optional(),
    scrapeOptions: watchScrapeOptionsSchema.nullable().optional(),
    focus: watchFocusSchema.nullable().optional(),
    extractRules: extractRulesSchema.nullable().optional(),
  })
  .refine(
    data => Object.keys(data).length > 0,
    "Provide at least one field to update",
  );

const idSchema = z.uuid();

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function issues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

function validateAndComputeNextRun(
  schedule: WatchSchedule,
  from: Date,
): { ok: true; next: Date } | { ok: false; error: string } {
  try {
    const firstRun = nextRunAt(schedule, from);
    if ("cron" in schedule) {
      const second = getNextMonitorRunAt(
        schedule.cron,
        firstRun,
        schedule.timezone,
      );
      const minimumMs = config.WATCH_MIN_INTERVAL_SECONDS * 1000;
      if (second.getTime() - firstRun.getTime() < minimumMs) {
        return {
          ok: false,
          error: `schedule: must not run more often than every ${config.WATCH_MIN_INTERVAL_SECONDS} seconds`,
        };
      }
    }
    return { ok: true, next: firstRun };
  } catch (error) {
    return {
      ok: false,
      error: "schedule: " + (error instanceof Error ? error.message : "invalid"),
    };
  }
}

/** A watch as returned to callers: the webhook secret is write-only. */
function publicWatch(watch: Watch) {
  return {
    ...watch,
    enabled: watch.enabled !== false,
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
  const next = validateAndComputeNextRun(body.data.schedule, now);
  if (!next.ok) return fail(res, 400, next.error);

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
    enabled: body.data.enabled,
    webhook: body.data.webhook ?? null,
    notifyOn: body.data.notifyOn,
    ...(body.data.scrapeOptions
      ? { scrapeOptions: body.data.scrapeOptions }
      : {}),
    ...(body.data.focus ? { focus: body.data.focus } : {}),
    ...(body.data.extractRules ? { extractRules: body.data.extractRules } : {}),
    createdAt: now.toISOString(),
    lastRunAt: null,
    lastStatus: null,
    nextRunAt: next.next.toISOString(),
  };
  await saveWatch(req.auth.team_id, watch);
  return res.status(200).json({ success: true, watch: publicWatch(watch) });
}

/** PATCH /v2/watch/:watchId */
export async function watchUpdateController(req: WatchRequest, res: Response) {
  if (!snapshotStoreEnabled) return fail(res, 501, UNAVAILABLE);
  if (!idSchema.safeParse(req.params.watchId).success) {
    return fail(res, 400, "Invalid watch ID.");
  }
  const existing = await getWatch(req.auth.team_id, req.params.watchId);
  if (!existing) return fail(res, 404, "Watch not found.");

  const body = updateSchema.safeParse(req.body);
  if (!body.success) return fail(res, 400, issues(body.error));

  const now = new Date();
  const nextSchedule = body.data.schedule ?? existing.schedule;
  let nextRunAtIso = existing.nextRunAt;
  if (
    body.data.schedule !== undefined ||
    (body.data.enabled === true && existing.enabled === false)
  ) {
    const next = validateAndComputeNextRun(nextSchedule, now);
    if (!next.ok) return fail(res, 400, next.error);
    nextRunAtIso = next.next.toISOString();
  }

  let nextWebhook = existing.webhook;
  if (body.data.webhook === null) {
    nextWebhook = null;
  } else if (body.data.webhook !== undefined) {
    nextWebhook = {
      ...body.data.webhook,
      // Keep the existing secret if the caller updates URL/headers without re-sending it.
      ...(body.data.webhook.secret === undefined && existing.webhook?.secret
        ? { secret: existing.webhook.secret }
        : {}),
    };
  }

  const updated: Watch = {
    ...existing,
    schedule: nextSchedule,
    enabled: body.data.enabled ?? existing.enabled ?? true,
    webhook: nextWebhook,
    notifyOn: body.data.notifyOn ?? existing.notifyOn,
    scrapeOptions:
      body.data.scrapeOptions !== undefined
        ? body.data.scrapeOptions
        : existing.scrapeOptions,
    focus: body.data.focus !== undefined ? body.data.focus : existing.focus,
    extractRules:
      body.data.extractRules !== undefined
        ? body.data.extractRules
        : existing.extractRules,
    nextRunAt: nextRunAtIso,
  };
  const extractRulesChanged =
    body.data.extractRules !== undefined &&
    JSON.stringify(existing.extractRules ?? null) !==
      JSON.stringify(updated.extractRules ?? null);
  await saveWatch(req.auth.team_id, updated);
  if (extractRulesChanged) {
    await clearWatchExtractedState(req.auth.team_id, updated.id);
  }
  return res.status(200).json({ success: true, watch: publicWatch(updated) });
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
