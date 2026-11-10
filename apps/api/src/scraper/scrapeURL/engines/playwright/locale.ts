/**
 * Browser locale and timezone for a requested country. The self-hosted
 * engine cannot change where a request comes from (that takes a proxy in the
 * country), but it can make the browser present as a visitor from there:
 * Accept-Language, navigator.language and the clock's timezone.
 *
 * Countries spanning several timezones use the most populous one.
 */
const COUNTRY_PROFILES: Record<string, { locale: string; timezone: string }> = {
  us: { locale: "en-US", timezone: "America/New_York" },
  ca: { locale: "en-CA", timezone: "America/Toronto" },
  mx: { locale: "es-MX", timezone: "America/Mexico_City" },
  br: { locale: "pt-BR", timezone: "America/Sao_Paulo" },
  ar: { locale: "es-AR", timezone: "America/Argentina/Buenos_Aires" },
  gb: { locale: "en-GB", timezone: "Europe/London" },
  ie: { locale: "en-IE", timezone: "Europe/Dublin" },
  fr: { locale: "fr-FR", timezone: "Europe/Paris" },
  de: { locale: "de-DE", timezone: "Europe/Berlin" },
  es: { locale: "es-ES", timezone: "Europe/Madrid" },
  it: { locale: "it-IT", timezone: "Europe/Rome" },
  pt: { locale: "pt-PT", timezone: "Europe/Lisbon" },
  nl: { locale: "nl-NL", timezone: "Europe/Amsterdam" },
  be: { locale: "nl-BE", timezone: "Europe/Brussels" },
  ch: { locale: "de-CH", timezone: "Europe/Zurich" },
  at: { locale: "de-AT", timezone: "Europe/Vienna" },
  se: { locale: "sv-SE", timezone: "Europe/Stockholm" },
  no: { locale: "nb-NO", timezone: "Europe/Oslo" },
  dk: { locale: "da-DK", timezone: "Europe/Copenhagen" },
  fi: { locale: "fi-FI", timezone: "Europe/Helsinki" },
  pl: { locale: "pl-PL", timezone: "Europe/Warsaw" },
  cz: { locale: "cs-CZ", timezone: "Europe/Prague" },
  tr: { locale: "tr-TR", timezone: "Europe/Istanbul" },
  il: { locale: "he-IL", timezone: "Asia/Jerusalem" },
  ae: { locale: "ar-AE", timezone: "Asia/Dubai" },
  in: { locale: "en-IN", timezone: "Asia/Kolkata" },
  sg: { locale: "en-SG", timezone: "Asia/Singapore" },
  jp: { locale: "ja-JP", timezone: "Asia/Tokyo" },
  kr: { locale: "ko-KR", timezone: "Asia/Seoul" },
  cn: { locale: "zh-CN", timezone: "Asia/Shanghai" },
  hk: { locale: "zh-HK", timezone: "Asia/Hong_Kong" },
  tw: { locale: "zh-TW", timezone: "Asia/Taipei" },
  au: { locale: "en-AU", timezone: "Australia/Sydney" },
  nz: { locale: "en-NZ", timezone: "Pacific/Auckland" },
  za: { locale: "en-ZA", timezone: "Africa/Johannesburg" },
};

export type BrowserLocale = {
  locale?: string;
  timezone_id?: string;
  languages?: string[];
};

export function browserLocaleFor(
  location: { country?: string; languages?: string[] } | undefined,
): BrowserLocale | undefined {
  if (!location) return undefined;
  // "us-generic" and similar special values still name a country.
  const country = location.country?.toLowerCase().split("-")[0];
  const profile = country ? COUNTRY_PROFILES[country] : undefined;
  const languages = location.languages?.length
    ? location.languages
    : profile
      ? [profile.locale]
      : undefined;
  if (!profile && !languages) return undefined;
  return {
    locale: languages?.[0] ?? profile?.locale,
    timezone_id: profile?.timezone,
    languages,
  };
}
