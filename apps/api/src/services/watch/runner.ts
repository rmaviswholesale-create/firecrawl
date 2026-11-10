import crypto from "crypto";
import undici from "undici";
import { config } from "../../config";
import { scrapeOptions } from "../../controllers/v2/types";
import { CostTracking } from "../../lib/cost-tracking";
import { logger as _logger } from "../../lib/logger";
import {
  type ChangeStatus,
  type Watch,
  type WatchRun,
  type WatchSchedule,
  getWatch,
  lockWatch,
  recordWatchRun,
  saveWatch,
} from "../../lib/watch-store";
import { scrapeURL } from "../../scraper/scrapeURL";
import {
  getSecureDispatcherNoCookies,
  isIPPrivate,
} from "../../scraper/scrapeURL/engines/utils/safeFetch";
import { getNextMonitorRunAt } from "../monitoring/cron";

const logger = _logger.child({ module: "watch" });

const SCRAPE_TIMEOUT_MS = 120_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
// Diffs are stored with each run and sent in the webhook; keep both small.
const MAX_DIFF_CHARS = 100_000;

export function nextRunAt(schedule: WatchSchedule, from: Date): Date {
  return "cron" in schedule
    ? getNextMonitorRunAt(schedule.cron, from, schedule.timezone)
    : new Date(from.getTime() + schedule.everySeconds * 1000);
}

async function deliverWebhook(
  webhook: NonNullable<Watch["webhook"]>,
  payload: unknown,
): Promise<NonNullable<WatchRun["webhook"]>> {
  if (
    isIPPrivate(new URL(webhook.url).hostname) &&
    config.ALLOW_LOCAL_WEBHOOKS !== true
  ) {
    return { delivered: false, error: "Webhook URL is a private address" };
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...webhook.headers,
  };
  if (webhook.secret) {
    headers["X-Firecrawl-Signature"] =
      "sha256=" +
      crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
  }

  try {
    const response = await undici.fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      dispatcher: getSecureDispatcherNoCookies(),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return response.ok
      ? { delivered: true, statusCode: response.status }
      : {
          delivered: false,
          statusCode: response.status,
          error: `Webhook responded with ${response.status}`,
        };
  } catch (error) {
    return {
      delivered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Scrapes a watch's URL, compares it with the last saved version, records the
 * run and notifies the webhook. Returns null when the watch does not exist or
 * is already running.
 */
export async function runWatch(
  teamId: string,
  id: string,
  trigger: WatchRun["trigger"],
): Promise<WatchRun | "busy" | null> {
  const release = await lockWatch(teamId, id);
  if (!release) return "busy";

  try {
    const watch = await getWatch(teamId, id);
    if (!watch) return null;

    const startedAt = new Date();
    const run: WatchRun = {
      id: crypto.randomUUID(),
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      changeStatus: null,
      snapshotId: null,
      comparedTo: null,
      diff: null,
      error: null,
      webhook: null,
    };

    try {
      const response = await scrapeURL(
        "watch;" + run.id,
        watch.url,
        scrapeOptions.parse({
          formats: [
            "markdown",
            // Each watch keeps its own history, apart from ad-hoc scrapes of
            // the same URL.
            {
              type: "changeTracking",
              modes: ["git-diff"],
              tag: "watch:" + watch.id,
            },
          ],
          timeout: SCRAPE_TIMEOUT_MS,
          maxAge: 0,
        }),
        { teamId, orgId: null },
        new CostTracking(),
      );
      if (!response.success) throw response.error;

      const tracking = response.document.changeTracking;
      if (!tracking) {
        throw new Error(
          response.document.warning ?? "Change tracking produced no result",
        );
      }
      run.changeStatus = tracking.changeStatus as ChangeStatus;
      run.snapshotId = tracking.snapshotId ?? null;
      run.comparedTo = tracking.comparedTo ?? null;
      const diff = tracking.diff?.text;
      run.diff = diff && diff.length <= MAX_DIFF_CHARS ? diff : null;
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      logger.warn("Watch run failed", { teamId, watchId: id, error });
    }

    if (
      watch.webhook &&
      run.changeStatus &&
      watch.notifyOn.includes(run.changeStatus)
    ) {
      run.webhook = await deliverWebhook(watch.webhook, {
        type: "watch." + run.changeStatus,
        watchId: watch.id,
        runId: run.id,
        url: watch.url,
        changeStatus: run.changeStatus,
        checkedAt: run.startedAt,
        snapshotId: run.snapshotId,
        comparedTo: run.comparedTo,
        diff: run.diff,
      });
    }

    const finishedAt = new Date();
    run.finishedAt = finishedAt.toISOString();
    await recordWatchRun(teamId, id, run);

    // The watch may have been deleted while it ran; do not bring it back.
    if (await getWatch(teamId, id)) {
      await saveWatch(teamId, {
        ...watch,
        lastRunAt: run.finishedAt,
        lastStatus: run.changeStatus ?? "error",
        nextRunAt: nextRunAt(watch.schedule, finishedAt).toISOString(),
      });
    }
    return run;
  } finally {
    await release();
  }
}
