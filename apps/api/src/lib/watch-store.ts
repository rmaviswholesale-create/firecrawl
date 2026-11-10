import crypto from "crypto";
import { getRedisConnection } from "../services/queue-service";

/**
 * Watches: a URL re-scraped on a schedule, with a webhook when it changes.
 * Kept in Redis beside the snapshot store they are built on.
 *
 *   watch:def:<team>:<id>   the watch, as JSON
 *   watch:idx:<team>        set of the team's watch ids
 *   watch:due               sorted set of "<team>:<id>", scored by next run
 *   watch:runs:<team>:<id>  list of recent runs, newest first
 *   watch:lock:<team>:<id>  held while a run is in progress
 */

export type WatchSchedule =
  | { cron: string; timezone: string }
  | { everySeconds: number };

export type ChangeStatus = "new" | "same" | "changed" | "removed";

export type Watch = {
  id: string;
  url: string;
  schedule: WatchSchedule;
  webhook: {
    url: string;
    headers?: Record<string, string>;
    secret?: string;
  } | null;
  notifyOn: ChangeStatus[];
  createdAt: string;
  lastRunAt: string | null;
  lastStatus: ChangeStatus | "error" | null;
  nextRunAt: string;
};

export type WatchRun = {
  id: string;
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt: string;
  changeStatus: ChangeStatus | null;
  snapshotId: string | null;
  comparedTo: { snapshotId: string; capturedAt: string } | null;
  /** Unified diff, when the page changed and the diff was small enough. */
  diff: string | null;
  error: string | null;
  webhook: {
    delivered: boolean;
    statusCode?: number;
    error?: string;
  } | null;
};

const RUN_HISTORY_LIMIT = 50;
// Long enough for a slow scrape; a crashed worker's lock expires on its own.
const RUN_LOCK_MS = 5 * 60_000;

const defKey = (teamId: string, id: string) => `watch:def:${teamId}:${id}`;
const idxKey = (teamId: string) => `watch:idx:${teamId}`;
const runsKey = (teamId: string, id: string) => `watch:runs:${teamId}:${id}`;
const lockKey = (teamId: string, id: string) => `watch:lock:${teamId}:${id}`;
const DUE_KEY = "watch:due";
// Watch ids are UUIDs, so the last ":" always separates team from id.
const dueMember = (teamId: string, id: string) => `${teamId}:${id}`;

export function newWatchId(): string {
  return crypto.randomUUID();
}

export async function countWatches(teamId: string): Promise<number> {
  return await getRedisConnection().scard(idxKey(teamId));
}

export async function saveWatch(teamId: string, watch: Watch): Promise<void> {
  await getRedisConnection()
    .multi()
    .set(defKey(teamId, watch.id), JSON.stringify(watch))
    .sadd(idxKey(teamId), watch.id)
    .zadd(
      DUE_KEY,
      new Date(watch.nextRunAt).getTime(),
      dueMember(teamId, watch.id),
    )
    .exec();
}

export async function getWatch(
  teamId: string,
  id: string,
): Promise<Watch | null> {
  const raw = await getRedisConnection().get(defKey(teamId, id));
  return raw ? (JSON.parse(raw) as Watch) : null;
}

export async function listWatches(teamId: string): Promise<Watch[]> {
  const ids = await getRedisConnection().smembers(idxKey(teamId));
  const watches = await Promise.all(ids.map(id => getWatch(teamId, id)));
  return watches
    .filter((watch): watch is Watch => watch !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteWatch(
  teamId: string,
  id: string,
): Promise<boolean> {
  const results = await getRedisConnection()
    .multi()
    .del(defKey(teamId, id))
    .srem(idxKey(teamId), id)
    .zrem(DUE_KEY, dueMember(teamId, id))
    .del(runsKey(teamId, id))
    .exec();
  return Number(results?.[0]?.[1] ?? 0) > 0;
}

export async function recordWatchRun(
  teamId: string,
  id: string,
  run: WatchRun,
): Promise<void> {
  await getRedisConnection()
    .multi()
    .lpush(runsKey(teamId, id), JSON.stringify(run))
    .ltrim(runsKey(teamId, id), 0, RUN_HISTORY_LIMIT - 1)
    .exec();
}

export async function listWatchRuns(
  teamId: string,
  id: string,
  limit: number,
): Promise<WatchRun[]> {
  const raw = await getRedisConnection().lrange(
    runsKey(teamId, id),
    0,
    limit - 1,
  );
  return raw.map(entry => JSON.parse(entry) as WatchRun);
}

/** Watches whose next run is due, as team and id pairs. */
export async function dueWatches(
  now: Date,
  limit: number,
): Promise<{ teamId: string; id: string }[]> {
  const members = await getRedisConnection().zrangebyscore(
    DUE_KEY,
    "-inf",
    now.getTime(),
    "LIMIT",
    0,
    limit,
  );
  return members.map(member => {
    const split = member.lastIndexOf(":");
    return { teamId: member.slice(0, split), id: member.slice(split + 1) };
  });
}

/** Removes a due entry whose watch no longer exists. */
export async function dropDueEntry(teamId: string, id: string): Promise<void> {
  await getRedisConnection().zrem(DUE_KEY, dueMember(teamId, id));
}

/**
 * Takes the run lock for a watch, so two workers (or a scheduled and a manual
 * run) never run it at once. Returns a release function, or null when the
 * watch is already running.
 */
export async function lockWatch(
  teamId: string,
  id: string,
): Promise<(() => Promise<void>) | null> {
  const redis = getRedisConnection();
  const token = crypto.randomUUID();
  const taken = await redis.set(
    lockKey(teamId, id),
    token,
    "PX",
    RUN_LOCK_MS,
    "NX",
  );
  if (taken !== "OK") return null;
  return async () => {
    // Only release a lock this call still holds.
    if ((await redis.get(lockKey(teamId, id))) === token) {
      await redis.del(lockKey(teamId, id));
    }
  };
}
