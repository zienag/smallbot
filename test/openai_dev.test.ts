import { describe, expect, it } from "vitest";
import { formatDevPost, parseDevIndex } from "../src/openai_dev";

describe("parseDevIndex", () => {
  it("takes the markdown twins and derives the human url", () => {
    expect(parseDevIndex(INDEX)).toEqual([
      {
        title: "15 lessons learned building ChatGPT Apps",
        mdUrl: "https://developers.openai.com/blog/15-lessons.md",
        url: "https://developers.openai.com/blog/15-lessons",
      },
      {
        title: "Custom Code Review rules for Codex",
        mdUrl: "https://developers.openai.com/blog/code-review-rules.md",
        url: "https://developers.openai.com/blog/code-review-rules",
      },
    ]);
  });

  it("skips the combined dump and section headers", () => {
    expect(parseDevIndex(INDEX).some((p) => p.title.includes("Combined"))).toBe(false);
  });
});

describe("formatDevPost", () => {
  const post = {
    title: "Custom <rules> for Codex",
    mdUrl: "https://developers.openai.com/blog/x.md",
    url: "https://developers.openai.com/blog/x",
  };

  it("renders a linked title, inline-formatted bullets and the source footer", () => {
    expect(formatDevPost(post, ["Adds `--strict`"], 3)).toBe(
      '<b><a href="https://developers.openai.com/blog/x">' +
        "Custom &lt;rules&gt; for Codex</a></b>\n\n• Adds <code>--strict</code>\n\n" +
        "<i>OpenAI Developers · 3 min read</i>",
    );
  });

  it("degrades to title and footer without bullets", () => {
    expect(formatDevPost(post, [], 3)).toBe(
      '<b><a href="https://developers.openai.com/blog/x">' +
        "Custom &lt;rules&gt; for Codex</a></b>\n\n<i>OpenAI Developers · 3 min read</i>",
    );
  });
});

const INDEX = `# Blog

> Developer blog posts and product updates.

## Documentation sets
- [Combined blog posts](https://developers.openai.com/blog/llms-full.txt): Single-file export.

## Posts
- [15 lessons learned building ChatGPT Apps](https://developers.openai.com/blog/15-lessons.md): And how we incorporated them.
- [Custom Code Review rules for Codex](https://developers.openai.com/blog/code-review-rules.md): Teach Codex your rules.
`;
