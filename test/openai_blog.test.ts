import { describe, expect, it } from "vitest";
import { formatOpenAiBlogPost, formatOpenAiModelPost } from "../src/openai_news";

describe("formatOpenAiBlogPost", () => {
  it("renders a linked header and inline-formatted bullets", () => {
    expect(formatOpenAiBlogPost(ITEM, ["Ships `gpt-5.5-codex`", "2x cheaper"])).toBe(
      '<b>OpenAI: <a href="https://openai.com/index/a-post">A &lt;new&gt; post</a></b>\n\n' +
        "• Ships <code>gpt-5.5-codex</code>\n• 2x cheaper",
    );
  });

  it("falls back to the feed sentence when the article could not be read", () => {
    expect(formatOpenAiBlogPost(ITEM, [])).toBe(formatOpenAiModelPost(ITEM));
  });
});

const ITEM = {
  title: "A <new> post",
  link: "https://openai.com/index/a-post",
  description: "One sentence from the feed.",
  guid: "https://openai.com/index/a-post",
};
