import { describe, it, expect } from "vitest";
import { scanJargon } from "@/lib/jargon-scan";

describe("scanJargon", () => {
  it("returns a single text segment when nothing matches", () => {
    const out = scanJargon("hello world");
    expect(out).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("wraps a single known term case-insensitively", () => {
    const out = scanJargon("Great Sharpe on this run.");
    expect(out.filter((s) => s.kind === "term")).toEqual([
      { kind: "term", text: "Sharpe", term: "sharpe" },
    ]);
  });

  it("prefers the longer alias when phrases nest", () => {
    const out = scanJargon("Max drawdown was 12%.");
    const terms = out.filter((s) => s.kind === "term");
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ text: "Max drawdown", term: "max_drawdown" });
  });

  it("only wraps the first occurrence of each term per string", () => {
    const out = scanJargon("Sharpe rose then Sharpe fell.");
    const terms = out.filter((s) => s.kind === "term");
    expect(terms).toHaveLength(1);
  });

  it("respects word boundaries and does not match inside other words", () => {
    const out = scanJargon("The pnlx column is unrelated.");
    expect(out.every((s) => s.kind === "text")).toBe(true);
  });

  it("handles multi-word aliases mid-sentence with punctuation", () => {
    const out = scanJargon("The equity curve, RSI and stop-loss all agreed.");
    const terms = out.filter((s) => s.kind === "term").map((s) => s.term);
    expect(terms).toEqual(["equity_curve", "rsi", "stop_loss"]);
  });

  it("returns empty for empty input", () => {
    expect(scanJargon("")).toEqual([]);
  });
});
