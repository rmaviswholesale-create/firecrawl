import { createTwoFilesPatch } from "diff";
import parseDiff from "parse-diff";

type StructuredMarkdownDiff = {
  files: Array<{
    from: string | null;
    to: string | null;
    chunks: Array<{
      content: string;
      changes: Array<{
        type: string;
        normal?: boolean;
        add?: boolean;
        del?: boolean;
        ln?: number;
        ln1?: number;
        ln2?: number;
        content: string;
      }>;
    }>;
  }>;
};

// The diff runs synchronously, and its cost grows with the square of the
// number of differing lines: two unrelated 20k-line documents take over a
// minute of CPU. These bounds make it give up instead, so one request cannot
// stall the process.
const DIFF_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DIFF_MAX_EDIT_LENGTH = 10_000;
const DIFF_TIMEOUT_MS = 2_000;

/**
 * A unified diff of two markdown documents. Returns undefined when they do
 * not differ, and also when the diff is too large to compute within bounds.
 */
export function createMarkdownChangeDiff(
  previousMarkdown: string,
  currentMarkdown: string,
): { text: string; json: StructuredMarkdownDiff } | undefined {
  if (previousMarkdown.length + currentMarkdown.length > DIFF_MAX_INPUT_BYTES) {
    return undefined;
  }

  const text = createTwoFilesPatch(
    "previous.md",
    "current.md",
    previousMarkdown,
    currentMarkdown,
    "",
    "",
    {
      context: 3,
      maxEditLength: DIFF_MAX_EDIT_LENGTH,
      timeout: DIFF_TIMEOUT_MS,
    },
  );
  // Undefined when a bound above was hit.
  if (text === undefined) return undefined;

  const structured = parseDiff(text);
  const hasChanges = structured.some(file =>
    file.chunks.some(chunk =>
      chunk.changes.some(
        change => change.type === "add" || change.type === "del",
      ),
    ),
  );

  if (!hasChanges) return undefined;

  return {
    text,
    json: {
      files: structured.map(file => ({
        from: file.from || null,
        to: file.to || null,
        chunks: file.chunks.map(chunk => ({
          content: chunk.content,
          changes: chunk.changes.map(change => {
            const baseChange = {
              type: change.type,
              content: change.content,
            };

            if (
              change.type === "normal" &&
              "ln1" in change &&
              "ln2" in change
            ) {
              return {
                ...baseChange,
                normal: true,
                ln1: change.ln1,
                ln2: change.ln2,
              };
            }
            if (change.type === "add" && "ln" in change) {
              return {
                ...baseChange,
                add: true,
                ln: change.ln,
              };
            }
            if (change.type === "del" && "ln" in change) {
              return {
                ...baseChange,
                del: true,
                ln: change.ln,
              };
            }

            return baseChange;
          }),
        })),
      })),
    },
  };
}
