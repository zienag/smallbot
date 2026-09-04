import { describe, expect, it } from "vitest";
import { markdownTitle } from "../src/browser";

describe("markdownTitle", () => {
  it("takes the first heading and drops the site suffix", () => {
    expect(markdownTitle("nav · nav\n\n# GPT-6 Astra: A new generation of intelligence | OpenAI\n\nWe're introducing")).toBe(
      "GPT-6 Astra: A new generation of intelligence",
    );
  });

  it("has no title for a render without a heading", () => {
    expect(markdownTitle("Just a paragraph.\n## Not a top heading")).toBeNull();
  });
});
