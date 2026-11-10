import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { snapshotStoreEnabled } from "../../lib/snapshot-store";
import { dropDueEntry, dueWatches } from "../../lib/watch-store";
import { runWatch } from "./runner";

const logger = _logger.child({ module: "watch-scheduler" });

// Watches started per poll. The rest stay due and run on the next one.
const MAX_RUNS_PER_POLL = 5;

let polling = false;

async function poll(): Promise<void> {
  // A poll that outlasts the interval must not overlap the next one.
  if (polling) return;
  polling = true;
  try {
    const due = await dueWatches(new Date(), MAX_RUNS_PER_POLL);
    await Promise.all(
      due.map(async ({ teamId, id }) => {
        const result = await runWatch(teamId, id, "schedule");
        if (result === null) await dropDueEntry(teamId, id);
      }),
    );
  } catch (error) {
    logger.error("Watch poll failed", { error });
  } finally {
    polling = false;
  }
}

/**
 * Starts running due watches from this process. Safe to start in several
 * workers: each run takes a per-watch lock. Returns a function that stops it.
 */
export function startWatchScheduler(): () => void {
  if (!snapshotStoreEnabled) return () => {};
  const timer = setInterval(() => void poll(), config.WATCH_POLL_INTERVAL_MS);
  timer.unref();
  logger.info("Watch scheduler started", {
    pollIntervalMs: config.WATCH_POLL_INTERVAL_MS,
  });
  return () => clearInterval(timer);
}
