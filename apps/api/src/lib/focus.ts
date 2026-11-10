import type { FocusResult } from "../controllers/v2/types";

/**
 * Query-focused markdown: picks the blocks of a page that best match a query
 * and fits them to a token budget. Ranking is BM25 over the page's own
 * blocks, so it needs no model, no network call and no index.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have how i if in " +
    "is it its me my not of on or our so than that the their them then there " +
    "these they this to was we were what when where which who why will with " +
    "you your"
  ).split(" "),
);

const BM25_K1 = 1.5;
const BM25_B = 0.75;
// A block under a matching heading is about the query even when it does not
// repeat the query's words; count heading terms at reduced weight.
const HEADING_WEIGHT = 0.5;

type Block = {
  text: string;
  isHeading: boolean;
  /** Index of the nearest heading block above this one, or -1. */
  headingIndex: number;
  /** Text of the headings this block sits under, outermost first. */
  headingPath: string[];
  tokens: number;
};

/** Rough token count; ~4 characters per token holds for English prose. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stem(term: string): string {
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("ies")) return term.slice(0, -3) + "y";
  if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }
  return term;
}

function tokenize(text: string): string[] {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.filter(term => !STOPWORDS.has(term)).map(stem);
}

/**
 * Splits markdown into blocks at blank lines, keeping fenced code blocks
 * whole and recording which headings each block sits under.
 */
function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const headings: { level: number; text: string; index: number }[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    const isHeading = heading !== null && !text.includes("\n");
    if (isHeading) {
      const level = heading![1].length;
      while (headings.length > 0 && headings.at(-1)!.level >= level) {
        headings.pop();
      }
    }
    blocks.push({
      text,
      isHeading,
      headingIndex: headings.at(-1)?.index ?? -1,
      headingPath: headings.map(h => h.text),
      tokens: estimateTokens(text),
    });
    if (isHeading) {
      headings.push({
        level: heading![1].length,
        text: heading![2].trim(),
        index: blocks.length - 1,
      });
    }
  };

  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence !== null) {
      buffer.push(line);
      if (fenceMatch && fenceMatch[1].startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      buffer.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    // A heading always starts its own block, even without a blank line.
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      buffer.push(line);
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function termCounts(terms: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

export function focusMarkdown(
  markdown: string,
  query: string,
  maxTokens: number,
): FocusResult {
  const sourceEstimatedTokens = estimateTokens(markdown);
  const empty: FocusResult = {
    query,
    markdown: "",
    estimatedTokens: 0,
    sourceEstimatedTokens,
    sections: [],
  };

  const queryTerms = [...new Set(tokenize(query))];
  const blocks = splitBlocks(markdown);
  if (queryTerms.length === 0 || blocks.length === 0) return empty;

  const bodies = blocks.map(block => termCounts(tokenize(block.text)));
  const headingTerms = blocks.map(block =>
    termCounts(tokenize(block.headingPath.join(" "))),
  );
  const lengths = bodies.map(counts =>
    [...counts.values()].reduce((a, b) => a + b, 0),
  );
  const averageLength =
    lengths.reduce((a, b) => a + b, 0) / Math.max(blocks.length, 1) || 1;

  const scores = blocks.map((_, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const containing = bodies.filter(counts => counts.has(term)).length;
      const idf = Math.log(
        1 + (blocks.length - containing + 0.5) / (containing + 0.5),
      );
      const frequency =
        (bodies[i].get(term) ?? 0) +
        HEADING_WEIGHT * (headingTerms[i].get(term) ?? 0);
      if (frequency === 0) continue;
      score +=
        (idf * frequency * (BM25_K1 + 1)) /
        (frequency +
          BM25_K1 * (1 - BM25_B + (BM25_B * lengths[i]) / averageLength));
    }
    return score;
  });

  // Best blocks first, until the budget is spent. A heading alone says
  // nothing, so headings are only pulled in as context for chosen blocks.
  const ranked = blocks
    .map((_, i) => i)
    .filter(i => scores[i] > 0 && !blocks[i].isHeading)
    .sort((a, b) => scores[b] - scores[a] || a - b);

  const chosen = new Set<number>();
  let spent = 0;
  for (const i of ranked) {
    const headingIndex = blocks[i].headingIndex;
    const headingCost =
      headingIndex >= 0 && !chosen.has(headingIndex)
        ? blocks[headingIndex].tokens
        : 0;
    const cost = blocks[i].tokens + headingCost;
    if (spent + cost > maxTokens) continue;
    chosen.add(i);
    if (headingIndex >= 0) chosen.add(headingIndex);
    spent += cost;
  }

  if (chosen.size === 0) {
    // Nothing fits whole: return the top block cut to the budget rather than
    // nothing at all.
    const top = ranked[0];
    if (top === undefined) return empty;
    const text = blocks[top].text.slice(0, maxTokens * 4);
    return {
      query,
      markdown: text,
      estimatedTokens: estimateTokens(text),
      sourceEstimatedTokens,
      sections: [
        {
          heading: blocks[top].headingPath.at(-1) ?? null,
          score: round(scores[top]),
        },
      ],
    };
  }

  const ordered = [...chosen].sort((a, b) => a - b);
  const output = ordered.map(i => blocks[i].text).join("\n\n");

  const sectionScores = new Map<string | null, number>();
  for (const i of ordered) {
    if (blocks[i].isHeading) continue;
    const heading = blocks[i].headingPath.at(-1) ?? null;
    sectionScores.set(
      heading,
      Math.max(sectionScores.get(heading) ?? 0, scores[i]),
    );
  }

  return {
    query,
    markdown: output,
    estimatedTokens: estimateTokens(output),
    sourceEstimatedTokens,
    sections: [...sectionScores.entries()]
      .map(([heading, score]) => ({ heading, score: round(score) }))
      .sort((a, b) => b.score - a.score),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
