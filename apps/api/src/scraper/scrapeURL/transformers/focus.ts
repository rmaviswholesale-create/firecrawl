import { Document } from "../../../controllers/v2/types";
import { Meta } from "..";
import { hasFormatOfType } from "../../../lib/format-utils";
import { focusMarkdown } from "../../../lib/focus";

export async function performFocus(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const focusFormat = hasFormatOfType(meta.options.formats, "focus");
  if (!focusFormat) return document;

  if (document.markdown === undefined) {
    document.warning =
      "The focus format needs page markdown, and this scrape produced none." +
      (document.warning ? " " + document.warning : "");
    return document;
  }

  document.focus = focusMarkdown(
    document.markdown,
    focusFormat.query,
    focusFormat.maxTokens,
  );
  if (document.focus.markdown === "") {
    document.warning =
      "No part of the page matched the focus query." +
      (document.warning ? " " + document.warning : "");
  }
  return document;
}
