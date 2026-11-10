import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";
import { hasFormatOfType } from "../../../../lib/format-utils";
import { ActionError } from "../../error";

const networkEntrySchema = z.object({
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  status: z.number(),
  contentType: z.string().optional(),
  requestBody: z.string().optional(),
  json: z.unknown().optional(),
  text: z.string().optional(),
  sizeBytes: z.number().optional(),
  truncated: z.boolean().optional(),
  startedAtMs: z.number(),
});

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const networkFormat = hasFormatOfType(meta.options.formats, "network");
  const actions = meta.options.actions ?? [];

  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
      ...(actions.length > 0 ? { actions } : {}),
      ...(screenshotFormat
        ? {
            screenshot: {
              fullPage: screenshotFormat.fullPage,
              quality: screenshotFormat.quality,
              viewport: screenshotFormat.viewport,
            },
          }
        : {}),
      ...(meta.options.mobile ? { mobile: true } : {}),
      ...(networkFormat
        ? {
            capture_network: {
              resourceTypes: networkFormat.resourceTypes,
              urlPattern: networkFormat.urlPattern,
              includeBodies: networkFormat.includeBodies,
              maxRequests: networkFormat.maxRequests,
              maxBodyBytes: networkFormat.maxBodyBytes,
            },
          }
        : {}),
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
      // Optional: older playwright-service builds don't send it.
      url: z.string().optional(),
      // Optional: older playwright-service builds ignore actions, screenshots
      // and network capture, and send none of these back.
      actionError: z.string().optional(),
      screenshot: z.string().optional(),
      actions: z
        .object({
          screenshots: z.array(z.string()),
          scrapes: z.array(z.object({ url: z.string(), html: z.string() })),
          javascriptReturns: z.array(
            z.object({ type: z.string(), value: z.unknown() }),
          ),
          pdfs: z.array(z.string()),
        })
        .optional(),
      network: z
        .object({
          requests: z.array(networkEntrySchema),
          total: z.number(),
          truncated: z.boolean(),
        })
        .optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  if (response.actionError) {
    throw new ActionError(response.actionError);
  }

  // An older playwright-service accepts the request but silently skips what it
  // does not know. Say so instead of returning a page the actions never ran on.
  const skipped = [
    actions.length > 0 && !response.actions ? "actions" : null,
    screenshotFormat && !response.screenshot ? "screenshot" : null,
    networkFormat && !response.network ? "network capture" : null,
  ].filter((x): x is string => x !== null);
  const warning =
    skipped.length > 0
      ? `The Playwright service did not run: ${skipped.join(", ")}. Update playwright-service to a build that supports them.`
      : undefined;

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    // The landed URL reported by the service. Redirect threat and blocklist
    // re-checks compare it against the requested URL. Falls back to the
    // requested URL for older services or a non-http(s) value (about:blank).
    url: landedHttpUrl(response.url) ?? meta.rewrittenUrl ?? meta.url,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    screenshot: response.screenshot,
    actions: response.actions,
    network: response.network,
    warning,

    proxyUsed: "basic",
  };
}

function landedHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function playwrightMaxReasonableTime(meta: Meta): number {
  const actionWait = (meta.options.actions ?? []).reduce(
    (total, action) =>
      action.type === "wait" ? total + (action.milliseconds ?? 1000) : total,
    0,
  );
  return (meta.options.waitFor ?? 0) + actionWait + 30000;
}
