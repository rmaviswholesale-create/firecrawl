import crypto from "crypto";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import { config } from "../config";
import { getRedisConnection } from "../services/queue-service";
import type { ScrapeOptions } from "../controllers/v2/types";

/**
 * Page cache for deployments without the hosted index: a live scrape's raw
 * result is kept in Redis and served to later scrapes of the same URL that
 * accept a copy that old (`maxAge`). Off unless LOCAL_CACHE_ENABLED is set.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const localCacheEnabled = config.LOCAL_CACHE_ENABLED === true;

export type LocalCacheEntry = {
  url: string;
  html: string;
  statusCode: number;
  contentType?: string;
  proxyUsed: "basic" | "stealth";
  createdAt: Date;
};

type CacheRequest = {
  url: string;
  options: ScrapeOptions;
  teamId: string | undefined;
  zeroDataRetention: boolean | undefined;
};

/** The longest a cached copy may have existed and still be served. */
function effectiveMaxAge(options: ScrapeOptions): number {
  return options.maxAge ?? config.LOCAL_CACHE_DEFAULT_MAX_AGE_MS;
}

/**
 * Only plain page loads are cacheable. Anything that makes the page
 * request-specific (actions, headers, a profile) or that needs output a cached
 * copy does not hold (screenshots, network capture) always scrapes live.
 */
export function isLocalCacheable(request: CacheRequest): boolean {
  const { options } = request;
  if (!localCacheEnabled || request.zeroDataRetention) return false;
  if (options.actions?.length || options.profile || options.lockdown) {
    return false;
  }
  if (options.headers && Object.keys(options.headers).length > 0) return false;
  return !options.formats.some(format =>
    [
      "screenshot",
      "network",
      "changeTracking",
      "branding",
      "rawBase64",
      "audio",
      "video",
    ].includes(format.type),
  );
}

function cacheKey(request: CacheRequest, engine: string): string {
  const { options } = request;
  // Everything that changes what the page load returns.
  const variant = JSON.stringify({
    engine,
    mobile: options.mobile,
    waitFor: options.waitFor,
    location: options.location ?? null,
    proxy: options.proxy,
    skipTlsVerification: options.skipTlsVerification ?? false,
    blockAds: options.blockAds,
  });
  const hash = crypto
    .createHash("sha256")
    .update(request.url)
    .update("\0")
    .update(variant)
    .digest("hex");
  return `pagecache:${request.teamId ?? "local"}:${hash}`;
}

export async function getLocalCache(
  request: CacheRequest,
  engine: string,
): Promise<LocalCacheEntry | null> {
  const maxAge = effectiveMaxAge(request.options);
  if (maxAge <= 0) return null;

  const key = cacheKey(request, engine);
  const [meta, body] = await Promise.all([
    getRedisConnection().hget(key, "meta"),
    getRedisConnection().hgetBuffer(key, "html"),
  ]);
  if (!meta || !body) return null;

  const parsed = JSON.parse(meta) as Omit<
    LocalCacheEntry,
    "html" | "createdAt"
  > & { createdAt: string };
  const createdAt = new Date(parsed.createdAt);
  if (Date.now() - createdAt.getTime() > maxAge) return null;

  return {
    ...parsed,
    createdAt,
    html: (await gunzipAsync(body)).toString("utf8"),
  };
}

export async function setLocalCache(
  request: CacheRequest,
  engine: string,
  entry: Omit<LocalCacheEntry, "createdAt">,
): Promise<void> {
  if (request.options.storeInCache === false) return;
  // A failed load is not worth replaying to later callers.
  if (entry.statusCode < 200 || entry.statusCode >= 300) return;
  if (Buffer.byteLength(entry.html, "utf8") > config.LOCAL_CACHE_MAX_BYTES) {
    return;
  }

  const key = cacheKey(request, engine);
  const { html, ...rest } = entry;
  await getRedisConnection()
    .multi()
    .hset(key, {
      meta: JSON.stringify({ ...rest, createdAt: new Date().toISOString() }),
      html: await gzipAsync(Buffer.from(html, "utf8")),
    })
    .expire(key, config.LOCAL_CACHE_TTL_SECONDS)
    .exec();
}
