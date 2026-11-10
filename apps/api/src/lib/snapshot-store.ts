import crypto from "crypto";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import { config } from "../config";
import { getRedisConnection } from "../services/queue-service";

/**
 * Local page-version history, kept in Redis. It backs change tracking when
 * Bigtable and GCS are not configured, and unlike that pair it keeps more
 * than the latest scrape, so a page can be compared against any earlier
 * version.
 *
 * Per (team, url, tag):
 *   snap:idx:<key>   sorted set of snapshot ids, scored by capture time
 *   snap:meta:<key>  hash: lastScrapeAt, url, tag
 *   snap:body:<id>   hash: the snapshot, markdown gzipped
 *
 * A snapshot is a distinct version of the page: a scrape whose markdown
 * matches the newest snapshot only moves lastScrapeAt forward.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const snapshotStoreEnabled =
  config.SNAPSHOT_STORE_ENABLED ??
  (config.USE_DB_AUTHENTICATION !== true && !config.BIGTABLE_INSTANCE_ID);

export type SnapshotSummary = {
  id: string;
  url: string;
  tag: string | null;
  capturedAt: string;
  contentHash: string;
  statusCode: number | null;
  sizeBytes: number;
};

export type Snapshot = SnapshotSummary & { markdown: string };

type SnapshotScope = { teamId: string; url: string; tag: string | null };

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Content identity for change detection. Whitespace and iframe placeholders
 * are dropped so re-renders that only reflow text do not read as changes.
 */
export function contentFingerprint(markdown: string): string {
  return sha256(markdown.replace(/\[iframe\]\(.+?\)/g, "").replace(/\s+/g, ""));
}

function scopeKey(scope: SnapshotScope): string {
  // null and "" are distinct tags.
  const tagPart = scope.tag === null ? "0" : "1" + scope.tag;
  return `${scope.teamId}:${sha256(scope.url)}:${sha256(tagPart)}`;
}

const idxKey = (scope: SnapshotScope) => `snap:idx:${scopeKey(scope)}`;
const metaKey = (scope: SnapshotScope) => `snap:meta:${scopeKey(scope)}`;
const bodyKey = (teamId: string, id: string) => `snap:body:${teamId}:${id}`;

const ttlSeconds = () => config.SNAPSHOT_TTL_DAYS * 86_400;

async function readSummary(
  teamId: string,
  id: string,
): Promise<SnapshotSummary | null> {
  const [url, tag, capturedAt, contentHash, statusCode, sizeBytes] =
    await getRedisConnection().hmget(
      bodyKey(teamId, id),
      "url",
      "tag",
      "capturedAt",
      "contentHash",
      "statusCode",
      "sizeBytes",
    );
  if (!url || !capturedAt || !contentHash) return null;
  return {
    id,
    url,
    tag: tag ? (JSON.parse(tag) as string | null) : null,
    capturedAt,
    contentHash,
    statusCode: statusCode ? Number(statusCode) : null,
    sizeBytes: Number(sizeBytes ?? 0),
  };
}

export async function getSnapshot(
  teamId: string,
  id: string,
): Promise<Snapshot | null> {
  const summary = await readSummary(teamId, id);
  if (!summary) return null;
  const compressed = await getRedisConnection().hgetBuffer(
    bodyKey(teamId, id),
    "markdown",
  );
  if (!compressed) return null;
  const markdown = (await gunzipAsync(compressed)).toString("utf8");
  return { ...summary, markdown };
}

/** Snapshots for a page, newest first. */
export async function listSnapshots(
  scope: SnapshotScope,
  limit: number,
): Promise<SnapshotSummary[]> {
  const ids = await getRedisConnection().zrevrange(idxKey(scope), 0, limit - 1);
  const summaries = await Promise.all(
    ids.map(id => readSummary(scope.teamId, id)),
  );
  return summaries.filter((s): s is SnapshotSummary => s !== null);
}

export async function getLatestSnapshot(
  scope: SnapshotScope,
): Promise<Snapshot | null> {
  const [id] = await getRedisConnection().zrevrange(idxKey(scope), 0, 0);
  return id ? getSnapshot(scope.teamId, id) : null;
}

/**
 * The page as it was at `at`: the newest snapshot captured at or before it.
 * When history starts later than `at`, the oldest snapshot is the closest
 * known state, so that is returned instead.
 */
export async function getSnapshotAsOf(
  scope: SnapshotScope,
  at: Date,
): Promise<Snapshot | null> {
  const redis = getRedisConnection();
  let [id] = await redis.zrevrangebyscore(
    idxKey(scope),
    at.getTime(),
    "-inf",
    "LIMIT",
    0,
    1,
  );
  if (!id) [id] = await redis.zrange(idxKey(scope), 0, 0);
  return id ? getSnapshot(scope.teamId, id) : null;
}

/** When this page was last scraped with change tracking, if ever. */
export async function getLastScrapeAt(
  scope: SnapshotScope,
): Promise<string | null> {
  return await getRedisConnection().hget(metaKey(scope), "lastScrapeAt");
}

/**
 * Records a scrape. Stores a new snapshot when the content differs from the
 * newest one, and returns the snapshot that now represents the page.
 */
export async function recordSnapshot(
  scope: SnapshotScope,
  params: { markdown: string; statusCode: number | null; capturedAt?: Date },
): Promise<{ snapshot: SnapshotSummary; created: boolean }> {
  const redis = getRedisConnection();
  const capturedAt = params.capturedAt ?? new Date();
  const contentHash = contentFingerprint(params.markdown);
  const ttl = ttlSeconds();

  const touch = async () => {
    await redis.hset(metaKey(scope), {
      lastScrapeAt: capturedAt.toISOString(),
      url: scope.url,
      tag: JSON.stringify(scope.tag),
    });
    if (ttl > 0) {
      await redis.expire(metaKey(scope), ttl);
      await redis.expire(idxKey(scope), ttl);
    }
  };

  const [latestId] = await redis.zrevrange(idxKey(scope), 0, 0);
  if (latestId) {
    const latest = await readSummary(scope.teamId, latestId);
    if (latest && latest.contentHash === contentHash) {
      await touch();
      if (ttl > 0) await redis.expire(bodyKey(scope.teamId, latestId), ttl);
      return { snapshot: latest, created: false };
    }
  }

  const id = crypto.randomUUID();
  const snapshot: SnapshotSummary = {
    id,
    url: scope.url,
    tag: scope.tag,
    capturedAt: capturedAt.toISOString(),
    contentHash,
    statusCode: params.statusCode,
    sizeBytes: Buffer.byteLength(params.markdown, "utf8"),
  };
  await redis.hset(bodyKey(scope.teamId, id), {
    url: snapshot.url,
    tag: JSON.stringify(snapshot.tag),
    capturedAt: snapshot.capturedAt,
    contentHash,
    statusCode: params.statusCode === null ? "" : String(params.statusCode),
    sizeBytes: String(snapshot.sizeBytes),
    markdown: await gzipAsync(Buffer.from(params.markdown, "utf8")),
  });
  if (ttl > 0) await redis.expire(bodyKey(scope.teamId, id), ttl);
  await redis.zadd(idxKey(scope), capturedAt.getTime(), id);
  await touch();

  // Keep the newest SNAPSHOT_HISTORY_LIMIT versions.
  const excess = await redis.zrange(
    idxKey(scope),
    0,
    -(config.SNAPSHOT_HISTORY_LIMIT + 1),
  );
  if (excess.length > 0) {
    await redis.zrem(idxKey(scope), ...excess);
    await redis.del(...excess.map(old => bodyKey(scope.teamId, old)));
  }

  return { snapshot, created: true };
}
