import { describe, expect, it } from "vitest";
import { createMarkdownChangeDiff } from "./change-tracking-diff";

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => `${prefix} line ${i}`).join("\n");

describe("createMarkdownChangeDiff", () => {
  it("returns a unified diff for a small change", () => {
    const diff = createMarkdownChangeDiff("price: $10\n", "price: $20\n");
    expect(diff?.text).toContain("-price: $10");
    expect(diff?.text).toContain("+price: $20");
  });

  it("returns undefined when nothing changed", () => {
    expect(createMarkdownChangeDiff("same\n", "same\n")).toBeUndefined();
  });

  it("gives up quickly on two large unrelated documents", () => {
    const started = Date.now();
    const diff = createMarkdownChangeDiff(lines(20000, "a"), lines(20000, "b"));
    expect(diff).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
