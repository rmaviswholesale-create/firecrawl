import { config } from "../config";
import { timingSafeSecretEqual } from "./secret-compare";

/**
 * API keys for deployments that do not use DB authentication. When
 * SELF_HOSTED_API_KEYS is set (comma-separated), every request must present
 * one of the keys as a Bearer token; when it is unset the API stays open, as
 * it always has been without DB authentication.
 */
export function parseSelfHostedApiKeys(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map(key => key.trim())
    .filter(key => key.length > 0);
}

const selfHostedApiKeys = parseSelfHostedApiKeys(config.SELF_HOSTED_API_KEYS);

export const selfHostedAuthEnabled =
  config.USE_DB_AUTHENTICATION !== true && selfHostedApiKeys.length > 0;

/** The Bearer token of an Authorization header, or null when there is none. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

export function isSelfHostedApiKey(
  token: string | null,
  keys: string[] = selfHostedApiKeys,
): boolean {
  if (!token) return false;
  // Compare against every key so timing does not reveal which one matched.
  let matched = false;
  for (const key of keys) {
    if (timingSafeSecretEqual(token, key)) matched = true;
  }
  return matched;
}
