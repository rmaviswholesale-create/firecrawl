const AGE_UNITS_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolves a `since` value to a point in time: an age such as "30m", "24h",
 * "7d" or "2w" counts back from `now`; anything else must be an ISO 8601
 * timestamp. Returns null when it is neither.
 */
export function parseSinceToDate(
  value: string,
  now: Date = new Date(),
): Date | null {
  const age = /^(\d{1,6})([mhdw])$/.exec(value.trim());
  if (age) {
    return new Date(now.getTime() - Number(age[1]) * AGE_UNITS_MS[age[2]]);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
