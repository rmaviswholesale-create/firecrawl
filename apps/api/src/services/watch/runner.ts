import crypto from "crypto";
import undici from "undici";
import { config } from "../../config";
import { scrapeOptions } from "../../controllers/v2/types";
import { createMarkdownChangeDiff } from "../../lib/change-tracking-diff";
import { CostTracking } from "../../lib/cost-tracking";
import { logger as _logger } from "../../lib/logger";
import { getLatestSnapshot, recordSnapshot } from "../../lib/snapshot-store";
import { diffStructuredValues } from "../../lib/structured-extract";
import {
  type ChangeStatus,
  type Watch,
  type WatchRun,
  type WatchSchedule,
  getWatch,
  getWatchExtractedState,
  lockWatch,
  recordWatchRun,
  saveWatch,
  saveWatchExtractedState,
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function deliverWebhook(
  webhook: NonNullable<Watch["webhook"]>,
  payload: unknown,
): Promise<NonNullable<WatchRun["webhook"]>> {
  if (
    isIPPrivate(new URL(webhook.url).hostname) &&
    config.ALLOW_LOCAL_WEBHOOKS !== true
  ) {
    return {
      delivered: false,
      attempts: 0,
      error: "Webhook URL is a private address",
    };
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

  const maxAttempts = config.WATCH_WEBHOOK_MAX_ATTEMPTS;
  const baseDelayMs = config.WATCH_WEBHOOK_RETRY_BASE_MS;
  let lastResult: NonNullable<WatchRun["webhook"]> = {
    delivered: false,
    attempts: 0,
    error: "Webhook delivery did not run",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await undici.fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        dispatcher: getSecureDispatcherNoCookies(),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        return {
          delivered: true,
          statusCode: response.status,
          attempts: attempt,
        };
      }
      lastResult = {
        delivered: false,
        statusCode: response.status,
        attempts: attempt,
        error: `Webhook responded with ${response.status}`,
      };
      if (!isRetryableStatus(response.status)) {
        return lastResult;
      }
    } catch (error) {
      lastResult = {
        delivered: false,
        attempts: attempt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (attempt < maxAttempts) {
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return lastResult;
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
      const hasExtractRules = Boolean(
        watch.extractRules && Object.keys(watch.extractRules).length > 0,
      );
      const hasFocus = Boolean(watch.focus?.query);
      const watchTag = "watch:" + watch.id;

      const formats: unknown[] = ["markdown"];
      if (hasExtractRules) {
        formats.push({
          type: "structured",
          rules: watch.extractRules,
          includeAuto: false,
        });
      } else if (hasFocus && watch.focus) {
        formats.push({
          type: "focus",
          query: watch.focus.query,
          ...(watch.focus.maxTokens !== undefined
            ? { maxTokens: watch.focus.maxTokens }
            : {}),
        });
      }
      // Plain markdown watches use the built-in changeTracking transformer.
      // Rule-based and focus-scoped watches compute change status from their
      // noise-free extracted content below.
      if (!hasExtractRules && !hasFocus) {
        formats.push({
          type: "changeTracking",
          modes: ["git-diff"],
          tag: watchTag,
        });
      }

      const opts = watch.scrapeOptions ?? {};
      const response = await scrapeURL(
        "watch;" + run.id,
        watch.url,
        scrapeOptions.parse({
          ...opts,
          formats,
          timeout: opts.timeout ?? SCRAPE_TIMEOUT_MS,
          maxAge: 0,
        }),
        { teamId, orgId: null },
        new CostTracking(),
      );
      if (!response.success) throw response.error;

      const doc = response.document;
      const statusCode = doc.metadata?.statusCode ?? null;

      if (hasExtractRules) {
        if (statusCode !== 404 && statusCode !== 410 && !doc.structured?.data) {
          throw new Error(
            doc.warning ?? "Structured extraction produced no result",
          );
        }
        const extracted = doc.structured?.data ?? {};
        run.extracted = extracted;
        const previous = await getWatchExtractedState(teamId, watch.id);
        if (statusCode === 404 || statusCode === 410) {
          run.changeStatus = "removed";
        } else if (previous === null) {
          run.changeStatus = "new";
          run.fieldChanges = [];
        } else {
          const changes = diffStructuredValues(previous, extracted);
          run.fieldChanges = changes;
          run.changeStatus = changes.length > 0 ? "changed" : "same";
          if (changes.length > 0) {
            const diff = createMarkdownChangeDiff(
              JSON.stringify(previous, null, 2),
              JSON.stringify(extracted, null, 2),
            );
            run.diff =
              diff?.text && diff.text.length <= MAX_DIFF_CHARS
                ? diff.text
                : null;
          }
        }
        if (run.changeStatus !== "removed") {
          const latestWatch = await getWatch(teamId, id);
          if (
            latestWatch &&
            JSON.stringify(latestWatch.extractRules ?? null) ===
              JSON.stringify(watch.extractRules ?? null)
          ) {
            await saveWatchExtractedState(teamId, watch.id, extracted);
          }
        }
      } else if (hasFocus) {
        if (statusCode !== 404 && statusCode !== 410 && !doc.focus) {
          throw new Error(doc.warning ?? "Focus extraction produced no result");
        }
        const focusedMarkdown = doc.focus?.markdown ?? "";
        const scope = { teamId, url: watch.url, tag: watchTag + ":focus" };
        const previous = await getLatestSnapshot(scope);
        if (statusCode === 404 || statusCode === 410) {
          run.changeStatus = "removed";
          if (previous) {
            run.comparedTo = {
              snapshotId: previous.id,
              capturedAt: previous.capturedAt,
            };
          }
        } else {
          const { snapshot, created } = await recordSnapshot(scope, {
            markdown: focusedMarkdown,
            statusCode,
          });
          run.snapshotId = snapshot.id;
          if (!previous) {
            run.changeStatus = "new";
          } else {
            run.comparedTo = {
              snapshotId: previous.id,
              capturedAt: previous.capturedAt,
            };
            run.changeStatus = created ? "changed" : "same";
            if (created) {
              const diff = createMarkdownChangeDiff(
                previous.markdown,
                focusedMarkdown,
              );
              run.diff =
                diff?.text && diff.text.length <= MAX_DIFF_CHARS
                  ? diff.text
                  : null;
            }
          }
        }
      } else {
        const tracking = doc.changeTracking;
        if (!tracking) {
          throw new Error(doc.warning ?? "Change tracking produced no result");
        }
        run.changeStatus = tracking.changeStatus as ChangeStatus;
        run.snapshotId = tracking.snapshotId ?? null;
        run.comparedTo = tracking.comparedTo ?? null;
        const diff = tracking.diff?.text;
        run.diff = diff && diff.length <= MAX_DIFF_CHARS ? diff : null;
      }
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
        ...(run.extracted !== undefined ? { extracted: run.extracted } : {}),
        ...(run.fieldChanges !== undefined
          ? { fieldChanges: run.fieldChanges }
          : {}),
      });
    }

    const finishedAt = new Date();
    run.finishedAt = finishedAt.toISOString();
    await recordWatchRun(teamId, id, run);

    // The watch may have been deleted or modified while it ran; re-read it.
    const latest = await getWatch(teamId, id);
    if (latest) {
      await saveWatch(teamId, {
        ...latest,
        lastRunAt: run.finishedAt,
        lastStatus: run.changeStatus ?? "error",
        nextRunAt: nextRunAt(latest.schedule, finishedAt).toISOString(),
      });
    }
    return run;
  } finally {
    await release();
  }
}
