import { changeTrackingGetLastScrape } from "../../../lib/change-tracking-store";
import { Document } from "../../../controllers/v2/types";
import { Meta } from "../index";
import { generateCompletions } from "./llmExtract";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { createMarkdownChangeDiff } from "../../../lib/change-tracking-diff";
import { UsOnlyUnavailableError } from "../error";
import {
  contentFingerprint,
  getLastScrapeAt,
  getLatestSnapshot,
  getSnapshotAsOf,
  recordSnapshot,
  snapshotStoreEnabled,
} from "../../../lib/snapshot-store";
import { parseSinceToDate } from "../../../lib/since";

type PreviousVersion = {
  markdown: string;
  /** Reported as previousScrapeAt. */
  scrapedAt: string;
  /** Set when the previous version came from the local snapshot store. */
  snapshot?: { snapshotId: string; capturedAt: string };
};

async function extractDataWithSchema(
  content: string,
  meta: Meta,
): Promise<{ extract: any } | null> {
  const changeTrackingFormat = hasFormatOfType(
    meta.options.formats,
    "changeTracking",
  )!;

  try {
    const { extract } = await generateCompletions({
      logger: meta.logger.child({
        method: "extractDataWithSchema/generateCompletions",
      }),
      options: {
        schema: changeTrackingFormat?.schema as any,
        systemPrompt:
          "Extract the requested information from the content based on the provided schema.",
        temperature: 0,
      },
      markdown: content,
      costTrackingOptions: {
        costTracking: meta.costTracking,
        metadata: {
          module: "extract",
          method: "extractDataWithSchema",
        },
      },
      metadata: {
        teamId: meta.internalOptions.teamId,
        functionId: "deriveDiff/extractDataWithSchema",
        scrapeId: meta.id,
      },
      teamFlags: meta.internalOptions.teamFlags,
    });
    return { extract };
  } catch (error) {
    if (error instanceof UsOnlyUnavailableError) throw error;
    meta.logger.error("Error extracting data with schema", { error });
    return null;
  }
}

function compareExtractedData(previousData: any, currentData: any): any {
  const result: Record<string, { previous: any; current: any }> = {};

  const allKeys = new Set([
    ...Object.keys(previousData || {}),
    ...Object.keys(currentData || {}),
  ]);

  for (const key of allKeys) {
    const oldValue = previousData?.[key];
    const newValue = currentData?.[key];

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      result[key] = {
        previous: oldValue,
        current: newValue,
      };
    }
  }

  return result;
}

export async function deriveDiff(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const changeTrackingFormat = hasFormatOfType(
    meta.options.formats,
    "changeTracking",
  );

  if (changeTrackingFormat) {
    if (meta.internalOptions.zeroDataRetention) {
      document.warning =
        "Change tracking is not supported with zero data retention." +
        (document.warning ? " " + document.warning : "");
      return document;
    }

    const url = document.metadata.sourceURL ?? meta.rewrittenUrl ?? meta.url;
    const tag = changeTrackingFormat.tag ?? null;
    const snapshotScope = snapshotStoreEnabled
      ? { teamId: meta.internalOptions.teamId ?? "local", url, tag }
      : null;

    let previous: PreviousVersion | null = null;
    try {
      if (snapshotScope) {
        const since = changeTrackingFormat.since
          ? parseSinceToDate(changeTrackingFormat.since)
          : null;
        const snapshot = since
          ? await getSnapshotAsOf(snapshotScope, since)
          : await getLatestSnapshot(snapshotScope);
        if (snapshot) {
          previous = {
            markdown: snapshot.markdown,
            scrapedAt: since
              ? snapshot.capturedAt
              : ((await getLastScrapeAt(snapshotScope)) ?? snapshot.capturedAt),
            snapshot: {
              snapshotId: snapshot.id,
              capturedAt: snapshot.capturedAt,
            },
          };
        }
      } else {
        if (changeTrackingFormat.since) {
          document.warning =
            "changeTracking.since needs the local snapshot store and was ignored; compared against the previous scrape instead." +
            (document.warning ? ` ${document.warning}` : "");
        }
        const start = Date.now();
        const last = await changeTrackingGetLastScrape({
          team_id: meta.internalOptions.teamId!,
          url,
          tag,
        });
        const end = Date.now();
        if (end - start > 100) {
          meta.logger.debug("Diffing took a while", {
            time: end - start,
            params: {
              i_team_id: meta.internalOptions.teamId,
              i_url: url,
            },
          });
        }

        const rawJob = last?.job_id ? await getJobFromGCS(last.job_id) : null;
        const job: Document | null = rawJob?.[0] ?? null;

        meta.logger.debug("Change tracking debugging", {
          isDataPresent: !!last,
          data: last,
          isRawJobPresent: !!rawJob,
          isJobPresent: !!job,
        });

        if (last && job) {
          previous = { markdown: job.markdown!, scrapedAt: last.date_added };
        }
      }
    } catch (error) {
      meta.logger.error("Error fetching previous scrape", { error });
      document.warning =
        "Comparing failed, please try again later." +
        (document.warning ? ` ${document.warning}` : "");
      return document;
    }

    if (previous) {
      const previousMarkdown = previous.markdown;
      const currentMarkdown = document.markdown!;

      const transformer = (x: string) =>
        [...x.replace(/\s+/g, "").replace(/\[iframe\]\(.+?\)/g, "")]
          .sort()
          .join("");
      // The local store compares exact text (minus whitespace); the hosted
      // comparison keeps its historical order-insensitive form.
      const isChanged = previous.snapshot
        ? contentFingerprint(previousMarkdown) !==
          contentFingerprint(currentMarkdown)
        : transformer(previousMarkdown) !== transformer(currentMarkdown);
      const changeStatus =
        document.metadata.statusCode === 404
          ? "removed"
          : isChanged
            ? "changed"
            : "same";

      document.changeTracking = {
        previousScrapeAt: previous.scrapedAt,
        changeStatus,
        visibility: meta.internalOptions.urlInvisibleInCurrentCrawl
          ? "hidden"
          : "visible",
        ...(previous.snapshot ? { comparedTo: previous.snapshot } : {}),
      };

      if (
        changeTrackingFormat?.modes?.includes("git-diff") &&
        changeStatus === "changed"
      ) {
        const diff = createMarkdownChangeDiff(
          previousMarkdown,
          currentMarkdown,
        );
        // meta.logger.debug("Diff text", { diffText: diff?.text });
        if (diff) {
          document.changeTracking.diff = {
            text: diff.text,
            json: diff.json,
          };
        }
      }

      if (
        changeTrackingFormat?.modes?.includes("json") &&
        changeStatus === "changed"
      ) {
        try {
          const previousData = changeTrackingFormat?.schema
            ? await extractDataWithSchema(previousMarkdown, meta)
            : null;

          const currentData = changeTrackingFormat?.schema
            ? await extractDataWithSchema(currentMarkdown, meta)
            : null;

          if (previousData && currentData) {
            document.changeTracking.json = compareExtractedData(
              previousData.extract,
              currentData.extract,
            );
          } else {
            const { extract } = await generateCompletions({
              logger: meta.logger.child({
                method: "deriveDiff/generateCompletions",
              }),
              options: {
                systemPrompt:
                  "Analyze the differences between the previous and current content and provide a structured summary of the changes.",
                schema: changeTrackingFormat?.schema,
                prompt: changeTrackingFormat?.prompt,
                temperature: 0,
              },
              markdown: `Previous Content:\n${previousMarkdown}\n\nCurrent Content:\n${currentMarkdown}`,
              previousWarning: document.warning,
              costTrackingOptions: {
                costTracking: meta.costTracking,
                metadata: {
                  module: "diff",
                  method: "deriveDiff",
                },
              },
              metadata: {
                teamId: meta.internalOptions.teamId,
                functionId: "deriveDiff",
                scrapeId: meta.id,
              },
              teamFlags: meta.internalOptions.teamFlags,
            });

            document.changeTracking.json = extract;
          }
        } catch (error) {
          const usOnly = error instanceof UsOnlyUnavailableError;
          if (!usOnly) {
            meta.logger.error("Error generating structured diff with LLM", {
              error,
            });
          }
          document.warning =
            (usOnly
              ? "Change tracking JSON mode is not available for teams restricted to US-only processing."
              : "Structured diff generation failed.") +
            (document.warning ? ` ${document.warning}` : "");
        }
      }
    } else {
      document.changeTracking = {
        previousScrapeAt: null,
        changeStatus: document.metadata.statusCode === 404 ? "removed" : "new",
        visibility: meta.internalOptions.urlInvisibleInCurrentCrawl
          ? "hidden"
          : "visible",
        ...(snapshotScope ? { comparedTo: null } : {}),
      };
    }

    // Save this scrape as the page's newest version. A removed page keeps its
    // last real content, so the next successful scrape still diffs against it.
    if (
      snapshotScope &&
      document.markdown !== undefined &&
      document.metadata.statusCode !== 404
    ) {
      try {
        const { snapshot } = await recordSnapshot(snapshotScope, {
          markdown: document.markdown,
          statusCode: document.metadata.statusCode ?? null,
        });
        document.changeTracking.snapshotId = snapshot.id;
      } catch (error) {
        meta.logger.error("Error saving change tracking snapshot", { error });
        document.warning =
          "This scrape could not be saved to the snapshot store, so later scrapes will not compare against it." +
          (document.warning ? ` ${document.warning}` : "");
      }
    }
  }

  return document;
}
