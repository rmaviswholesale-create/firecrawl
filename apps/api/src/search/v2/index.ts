import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";

export async function search({
  query,
  logger,
  requestId,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  safe = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
  includeDomains = undefined,
  excludeDomains = undefined,
  usOnly = false,
}: {
  query: string;
  logger: Logger;
  requestId?: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  includeDomains?: string[];
  excludeDomains?: string[];
  usOnly?: boolean;
}): Promise<SearchV2Response> {
  // The fallback backends below take no US-only routing.
  if (usOnly && !config.FIRE_ENGINE_BETA_URL) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }
  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      const results = await fire_engine_search_v2(query, {
        requestId,
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        enterprise,
        includeDomains,
        excludeDomains,
        usOnly,
      });

      return results;
    }

    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      const results = filterSearchResultsByDomain(
        await searxng_search(query, {
          num_results,
          tbs,
          filter,
          lang,
          country,
          location,
          safe,
        }),
        includeDomains,
        excludeDomains,
      );
      if (results.web && results.web.length > 0) return results;
    }

    logger.info("Using DuckDuckGo search");
    const ddgResults = filterSearchResultsByDomain(
      await ddgSearch(query, num_results, {
        tbs,
        lang,
        country,
        proxy,
        timeout,
      }),
      includeDomains,
      excludeDomains,
    );
    if (ddgResults.web && ddgResults.web.length > 0) return ddgResults;

    // Fallback to empty response
    return {};
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, "");
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const target = normalizeDomain(domain);
  return host === target || host.endsWith("." + target);
}

export function filterSearchResultsByDomain(
  results: SearchV2Response,
  includeDomains?: string[],
  excludeDomains?: string[],
): SearchV2Response {
  const hasInclude = Boolean(includeDomains && includeDomains.length > 0);
  const hasExclude = Boolean(excludeDomains && excludeDomains.length > 0);
  if (!hasInclude && !hasExclude) return results;

  const allowed = (url: string | undefined): boolean => {
    if (!url) return false;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    if (
      hasInclude &&
      !includeDomains!.some(domain => hostMatchesDomain(host, domain))
    ) {
      return false;
    }
    if (
      hasExclude &&
      excludeDomains!.some(domain => hostMatchesDomain(host, domain))
    ) {
      return false;
    }
    return true;
  };

  return {
    ...results,
    ...(results.web ? { web: results.web.filter(r => allowed(r.url)) } : {}),
    ...(results.news ? { news: results.news.filter(r => allowed(r.url)) } : {}),
    ...(results.images
      ? { images: results.images.filter(r => allowed(r.url)) }
      : {}),
  };
}
