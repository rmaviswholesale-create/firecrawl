import type { Page, Response as PlaywrightResponse } from 'playwright';

/**
 * Browser interaction for the self-hosted engine: scrape actions, screenshots
 * and network capture. Mirrors the request shapes the Firecrawl API validates
 * (`actions`, the `screenshot` format, the `network` format), so the API can
 * pass them through untouched.
 */

export type Viewport = { width: number; height: number };

export type ScreenshotOptions = {
  fullPage?: boolean;
  quality?: number;
  viewport?: Viewport;
};

export type Action =
  | { type: 'wait'; milliseconds?: number; selector?: string }
  | { type: 'click'; selector: string; all?: boolean }
  | ({ type: 'screenshot' } & ScreenshotOptions)
  | { type: 'write'; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction?: 'up' | 'down'; selector?: string }
  | { type: 'scrape' }
  | { type: 'executeJavascript'; script: string }
  | {
      type: 'pdf';
      landscape?: boolean;
      scale?: number;
      format?: string;
    };

export type ActionResults = {
  screenshots: string[];
  scrapes: { url: string; html: string }[];
  javascriptReturns: { type: string; value: unknown }[];
  pdfs: string[];
};

export class ActionFailedError extends Error {
  constructor(
    public readonly index: number,
    public readonly actionType: string,
    reason: string,
  ) {
    super(`Action ${index} (${actionType}) failed: ${reason}`);
    this.name = 'ActionFailedError';
  }
}

const ACTION_TYPES = new Set([
  'wait',
  'click',
  'screenshot',
  'write',
  'press',
  'scroll',
  'scrape',
  'executeJavascript',
  'pdf',
]);

const MAX_ACTIONS = 50;
// A click on an element that never appears should fail as an action error
// well before the whole scrape times out.
const CLICK_TIMEOUT_MS = 10_000;
// Leave time to serialize the page and answer before the caller gives up.
const DEADLINE_MARGIN_MS = 2_000;

/** Returns a reason when the actions payload is unusable, undefined when ok. */
export function validateActions(actions: unknown): string | undefined {
  if (actions === undefined) return undefined;
  if (!Array.isArray(actions)) return 'actions must be an array';
  if (actions.length > MAX_ACTIONS) {
    return `actions cannot exceed ${MAX_ACTIONS} entries`;
  }
  for (const [index, action] of actions.entries()) {
    if (typeof action !== 'object' || action === null) {
      return `action ${index} must be an object`;
    }
    const type = (action as { type?: unknown }).type;
    if (typeof type !== 'string' || !ACTION_TYPES.has(type)) {
      return `action ${index} has unsupported type "${String(type)}"`;
    }
  }
  return undefined;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message.split('\n')[0] : String(error);

export async function takeScreenshot(
  page: Page,
  options: ScreenshotOptions,
): Promise<string> {
  const previousViewport = page.viewportSize();
  if (options.viewport) {
    await page.setViewportSize(options.viewport);
  }
  try {
    // PNG is lossless and ignores quality, so a requested quality means JPEG.
    const jpeg = options.quality !== undefined;
    const buffer = await page.screenshot({
      fullPage: options.fullPage ?? false,
      type: jpeg ? 'jpeg' : 'png',
      ...(jpeg ? { quality: Math.round(options.quality!) } : {}),
    });
    return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${buffer.toString('base64')}`;
  } finally {
    if (options.viewport && previousViewport) {
      await page.setViewportSize(previousViewport);
    }
  }
}

async function runScript(page: Page, script: string): Promise<unknown> {
  try {
    return await page.evaluate(script);
  } catch (error) {
    // Scripts written as a function body ("return document.title") are not
    // expressions; run those inside an async function instead.
    if (/Illegal return|await is only valid/.test(errorMessage(error))) {
      return await page.evaluate(`(async () => { ${script}\n })()`);
    }
    throw error;
  }
}

async function runAction(
  page: Page,
  action: Action,
  results: ActionResults,
  stepTimeout: number,
): Promise<void> {
  switch (action.type) {
    case 'wait':
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: stepTimeout });
      } else {
        await page.waitForTimeout(action.milliseconds ?? 1000);
      }
      return;
    case 'click': {
      const clickTimeout = Math.min(stepTimeout, CLICK_TIMEOUT_MS);
      if (action.all) {
        const elements = await page.locator(action.selector).all();
        for (const element of elements) {
          await element.click({ timeout: clickTimeout });
        }
      } else {
        await page.locator(action.selector).first().click({
          timeout: clickTimeout,
        });
      }
      return;
    }
    case 'write':
      await page.keyboard.type(action.text);
      return;
    case 'press':
      await page.keyboard.press(action.key);
      return;
    case 'scroll': {
      const sign = action.direction === 'up' ? -1 : 1;
      if (action.selector) {
        await page
          .locator(action.selector)
          .first()
          .evaluate((element, direction) => {
            element.scrollBy(0, direction * element.clientHeight);
          }, sign);
      } else {
        await page.evaluate((direction) => {
          window.scrollBy(0, direction * window.innerHeight);
        }, sign);
      }
      return;
    }
    case 'screenshot':
      results.screenshots.push(await takeScreenshot(page, action));
      return;
    case 'scrape':
      results.scrapes.push({ url: page.url(), html: await page.content() });
      return;
    case 'executeJavascript': {
      const value = await runScript(page, action.script);
      results.javascriptReturns.push({ type: typeof value, value });
      return;
    }
    case 'pdf': {
      const buffer = await page.pdf({
        landscape: action.landscape ?? false,
        scale: action.scale ?? 1,
        format: action.format ?? 'Letter',
        printBackground: true,
      });
      results.pdfs.push(
        `data:application/pdf;base64,${buffer.toString('base64')}`,
      );
      return;
    }
  }
}

export async function runActions(
  page: Page,
  actions: Action[],
  deadline: number,
): Promise<ActionResults> {
  const results: ActionResults = {
    screenshots: [],
    scrapes: [],
    javascriptReturns: [],
    pdfs: [],
  };
  for (const [index, action] of actions.entries()) {
    const remaining = deadline - DEADLINE_MARGIN_MS - Date.now();
    if (remaining <= 0) {
      throw new ActionFailedError(index, action.type, 'scrape timed out');
    }
    try {
      await runAction(page, action, results, remaining);
    } catch (error) {
      throw new ActionFailedError(index, action.type, errorMessage(error));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Network capture
// ---------------------------------------------------------------------------

export type NetworkCaptureOptions = {
  resourceTypes?: string[];
  urlPattern?: string;
  includeBodies?: boolean;
  maxRequests?: number;
  maxBodyBytes?: number;
};

export type NetworkEntry = {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  contentType?: string;
  requestBody?: string;
  /** Parsed body, when the response is JSON and fits maxBodyBytes. */
  json?: unknown;
  /** Text body, when the response is textual but not JSON. */
  text?: string;
  sizeBytes?: number;
  truncated?: boolean;
  /** Milliseconds since capture began. */
  startedAtMs: number;
};

export type NetworkCaptureResult = {
  requests: NetworkEntry[];
  /** Matching responses seen, including ones past maxRequests. */
  total: number;
  truncated: boolean;
};

const DEFAULT_RESOURCE_TYPES = ['xhr', 'fetch'];
const DEFAULT_MAX_REQUESTS = 50;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

const isJson = (contentType: string | undefined): boolean =>
  !!contentType && /[/+]json\b/i.test(contentType);

const isText = (contentType: string | undefined): boolean =>
  !!contentType &&
  /^(text\/|application\/(xml|javascript|x-www-form-urlencoded|graphql))|\+xml\b/i.test(
    contentType,
  );

/** Compiles a user-supplied pattern; a bad pattern yields a reason instead. */
export function compileUrlPattern(
  pattern: string | undefined,
): { regex?: RegExp; error?: string } {
  if (!pattern) return {};
  if (pattern.length > 500) return { error: 'urlPattern is too long' };
  try {
    return { regex: new RegExp(pattern) };
  } catch (error) {
    return { error: `urlPattern is not a valid regex: ${errorMessage(error)}` };
  }
}

/**
 * Records the API calls a page makes while it loads and while actions run.
 * Call `collect()` once the page is done to settle body reads.
 */
export function startNetworkCapture(
  page: Page,
  options: NetworkCaptureOptions,
  urlRegex: RegExp | undefined,
): { collect: () => Promise<NetworkCaptureResult> } {
  const resourceTypes = new Set(
    options.resourceTypes?.length
      ? options.resourceTypes
      : DEFAULT_RESOURCE_TYPES,
  );
  const includeBodies = options.includeBodies ?? true;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const startedAt = Date.now();
  const pending: Promise<NetworkEntry | null>[] = [];
  let total = 0;

  const record = async (
    response: PlaywrightResponse,
    startedAtMs: number,
  ): Promise<NetworkEntry | null> => {
    const request = response.request();
    const contentType = response.headers()['content-type'];
    const entry: NetworkEntry = {
      url: response.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      ...(contentType ? { contentType } : {}),
      startedAtMs,
    };
    const requestBody = request.postData();
    if (requestBody) {
      entry.requestBody = requestBody.slice(0, MAX_REQUEST_BODY_BYTES);
    }
    if (!includeBodies) return entry;
    try {
      const body = await response.body();
      entry.sizeBytes = body.length;
      if (body.length > maxBodyBytes) {
        entry.truncated = true;
        if (isText(contentType) || isJson(contentType)) {
          entry.text = body.subarray(0, maxBodyBytes).toString('utf8');
        }
      } else if (isJson(contentType)) {
        const text = body.toString('utf8');
        try {
          entry.json = JSON.parse(text);
        } catch {
          entry.text = text;
        }
      } else if (isText(contentType)) {
        entry.text = body.toString('utf8');
      }
    } catch {
      // The body is gone once the page navigates away or the request was a
      // redirect; the entry is still worth returning without it.
    }
    return entry;
  };

  page.on('response', (response) => {
    const request = response.request();
    if (!resourceTypes.has(request.resourceType())) return;
    if (urlRegex && !urlRegex.test(response.url())) return;
    total++;
    if (pending.length >= maxRequests) return;
    const startedAtMs = Date.now() - startedAt;
    pending.push(record(response, startedAtMs).catch(() => null));
  });

  return {
    collect: async () => {
      const settled = await Promise.all(pending);
      const requests = settled.filter(
        (entry): entry is NetworkEntry => entry !== null,
      );
      return { requests, total, truncated: total > requests.length };
    },
  };
}

/** Context options that make Chromium present as a phone. */
export const MOBILE_CONTEXT = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
} as const;
