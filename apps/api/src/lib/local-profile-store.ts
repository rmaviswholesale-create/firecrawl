import crypto from "crypto";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import { z } from "zod";
import { config } from "../config";
import { getRedisConnection } from "../services/queue-service";

/**
 * Local persistent browser profiles, kept in Redis. Stores Playwright's
 * storageState (cookies + localStorage origins) per (team, profile name) so
 * self-hosted deployments can authenticate once and reuse sessions across
 * scrapes, crawls, and watches without Hangar or Fire-engine.
 */

const PROFILE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB uncompressed cap
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const localProfileStoreEnabled =
  config.LOCAL_PROFILE_STORE_ENABLED ??
  (config.USE_DB_AUTHENTICATION !== true && !config.HANGAR_URL);

export const browserStorageStateSchema = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
  origins: z.array(
    z.object({
      origin: z.string(),
      localStorage: z.array(
        z.object({
          name: z.string(),
          value: z.string(),
        }),
      ),
    }),
  ),
});

export type BrowserStorageState = z.infer<typeof browserStorageStateSchema>;

export type LocalProfileSummary = {
  name: string;
  cookieCount: number;
  originCount: number;
  sizeBytes: number;
  updatedAt: string;
};

function nameHash(name: string): string {
  return crypto.createHash("sha256").update(name).digest("hex");
}

const idxKey = (teamId: string) => `profile:idx:${teamId}`;
const dataKey = (teamId: string, name: string) =>
  `profile:data:${teamId}:${nameHash(name)}`;

const ttlSeconds = () => config.LOCAL_PROFILE_TTL_DAYS * 86_400;

export async function getLocalProfileSummary(
  teamId: string,
  name: string,
): Promise<LocalProfileSummary | null> {
  const [storedName, cookieCount, originCount, sizeBytes, updatedAt] =
    await getRedisConnection().hmget(
      dataKey(teamId, name),
      "name",
      "cookieCount",
      "originCount",
      "sizeBytes",
      "updatedAt",
    );
  if (!storedName || !updatedAt) return null;
  return {
    name: storedName,
    cookieCount: Number(cookieCount ?? 0),
    originCount: Number(originCount ?? 0),
    sizeBytes: Number(sizeBytes ?? 0),
    updatedAt,
  };
}

export async function getLocalProfile(
  teamId: string,
  name: string,
): Promise<BrowserStorageState | null> {
  const compressed = await getRedisConnection().hgetBuffer(
    dataKey(teamId, name),
    "state",
  );
  if (!compressed) return null;
  const raw = (await gunzipAsync(compressed)).toString("utf8");
  const parsed = browserStorageStateSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function listLocalProfiles(
  teamId: string,
): Promise<LocalProfileSummary[]> {
  const redis = getRedisConnection();
  const names = await redis.smembers(idxKey(teamId));
  const summaries = await Promise.all(
    names.map(async name => {
      const summary = await getLocalProfileSummary(teamId, name);
      if (!summary) {
        // Prune expired entry from index lazily.
        await redis.srem(idxKey(teamId), name).catch(() => {});
      }
      return summary;
    }),
  );
  return summaries
    .filter((s): s is LocalProfileSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveLocalProfile(
  teamId: string,
  name: string,
  state: BrowserStorageState,
): Promise<LocalProfileSummary> {
  const json = JSON.stringify(state);
  const sizeBytes = Buffer.byteLength(json, "utf8");
  if (sizeBytes > PROFILE_MAX_BYTES) {
    throw new Error(
      `Browser profile "${name}" exceeds the ${PROFILE_MAX_BYTES} byte limit`,
    );
  }
  const updatedAt = new Date().toISOString();
  const compressed = await gzipAsync(Buffer.from(json, "utf8"));
  const redis = getRedisConnection();
  const key = dataKey(teamId, name);
  const ttl = ttlSeconds();

  const multi = redis
    .multi()
    .hset(key, {
      name,
      cookieCount: String(state.cookies.length),
      originCount: String(state.origins.length),
      sizeBytes: String(sizeBytes),
      updatedAt,
      state: compressed,
    })
    .sadd(idxKey(teamId), name);
  if (ttl > 0) {
    multi.expire(key, ttl);
  }
  await multi.exec();

  return {
    name,
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
    sizeBytes,
    updatedAt,
  };
}

export async function deleteLocalProfile(
  teamId: string,
  name: string,
): Promise<boolean> {
  const results = await getRedisConnection()
    .multi()
    .del(dataKey(teamId, name))
    .srem(idxKey(teamId), name)
    .exec();
  return Number(results?.[0]?.[1] ?? 0) > 0;
}
