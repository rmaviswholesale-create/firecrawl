import { Document } from "../../../controllers/v2/types";
import { Meta } from "..";
import { hasFormatOfType } from "../../../lib/format-utils";
import { extractStructuredData } from "../../../lib/structured-extract";

export async function performStructuredExtract(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const structuredFormat = hasFormatOfType(meta.options.formats, "structured");
  if (!structuredFormat) return document;

  const html = document.rawHtml ?? document.html;
  if (html === undefined) {
    document.warning =
      "The structured format needs page HTML, and this scrape produced none." +
      (document.warning ? " " + document.warning : "");
    return document;
  }

  const baseUrl =
    document.metadata.url ??
    document.metadata.sourceURL ??
    meta.rewrittenUrl ??
    meta.url;

  document.structured = extractStructuredData(
    html,
    {
      rules: structuredFormat.rules,
      includeAuto: structuredFormat.includeAuto,
      includeTables: structuredFormat.includeTables,
    },
    baseUrl,
  );
  return document;
}
