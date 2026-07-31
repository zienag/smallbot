import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/changelog";
import { parseReleasesAtom } from "../src/codex";
import { articleText, htmlToText, pageTitle } from "../src/html";
import { articleImages, findPressRelease, formatNewModelsPost, isDatedSnapshot } from "../src/models";
import { formatOpenAiModelPost, parseRss } from "../src/openai_news";
import { compareVersions } from "../src/version";
import { buildPost, changelogAnchorUrl, escapeHtml, formatInline } from "../src/telegram";
import { pickLatestOpus } from "../src/summarize";

const fixture = readFileSync("test/fixtures-changelog.md", "utf8");
const codexAtom = readFileSync("test/fixtures-codex-releases.atom", "utf8");
const openaiRss = readFileSync("test/fixtures-openai-news.rss", "utf8");

describe("parseChangelog", () => {
  it("parses the real changelog fragment, newest first", () => {
    const releases = parseChangelog(fixture);
    expect(releases.map((r) => r.version)).toEqual([
      "2.1.212",
      "2.1.211",
      "2.1.210",
      "2.1.209",
      "2.1.208",
    ]);
  });

  it("captures full notes of a large release", () => {
    const [top] = parseChangelog(fixture);
    expect(top.notes).toMatch(/^- `\/fork` now copies/);
    expect(top.notes.split("\n").length).toBeGreaterThan(30);
    expect(top.notes).not.toContain("## ");
  });

  it("captures a single-bullet release", () => {
    const release = parseChangelog(fixture).find((r) => r.version === "2.1.209");
    expect(release?.notes).toBe(
      "- Fixed /model and other dialogs being blocked in `claude agents` background sessions (reverts an overly broad guard)",
    );
  });
});

describe("pickLatestOpus", () => {
  it("picks the highest opus alias, ignoring dated snapshots and other tiers", () => {
    expect(
      pickLatestOpus([
        "claude-fable-5",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-4-5-20251101",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
      ]),
    ).toBe("claude-opus-4-8");
  });

  it("prefers a future major over the current minor", () => {
    expect(pickLatestOpus(["claude-opus-4-8", "claude-opus-5"])).toBe("claude-opus-5");
  });

  it("returns null when no opus alias is present", () => {
    expect(pickLatestOpus(["claude-sonnet-5", "claude-opus-4-5-20251101"])).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders semver numerically, not lexically", () => {
    expect(compareVersions("2.1.9", "2.1.212")).toBeLessThan(0);
    expect(compareVersions("2.1.212", "2.1.211")).toBeGreaterThan(0);
    expect(compareVersions("2.1.212", "2.1.212")).toBe(0);
    expect(compareVersions("3.0.0", "2.99.99")).toBeGreaterThan(0);
  });
});

describe("buildPost", () => {
  const summary = { bullets: ["point <one>", "run `/fork` & `--flag`"] };
  const claudePost = (version: string, notes?: string) =>
    buildPost({ product: "Claude Code", version, url: changelogAnchorUrl(version), summary, notes });

  it("inlines short notes as expandable blockquote, escaped", () => {
    const notes = "- Fixed `<thing>` & stuff\n- Second item\n- Third item";
    const post = claudePost("2.1.209", notes);
    expect(post).toContain(
      '<b>Claude Code <a href="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21209">2.1.209</a></b>',
    );
    expect(post).toContain("• point &lt;one&gt;");
    expect(post).toContain("• run <code>/fork</code> &amp; <code>--flag</code>");
    expect(post).toContain(
      "<blockquote expandable>- Fixed <code>&lt;thing&gt;</code> &amp; stuff\n- Second item\n- Third item</blockquote>",
    );
  });

  it("skips the blockquote when the summary already covers every notes line", () => {
    expect(claudePost("2.1.215", "- The only item, reworded by the summary")).not.toContain("<blockquote");
    expect(claudePost("2.1.215", "- First item\n\n- Second item\n")).not.toContain("<blockquote");
  });

  it("skips the blockquote when notes are not passed at all", () => {
    const post = buildPost({
      product: "Codex",
      version: "0.144.6",
      url: "https://github.com/openai/codex/releases/tag/rust-v0.144.6",
      summary,
    });
    expect(post).not.toContain("<blockquote");
    expect(post).toContain(
      '<b>Codex <a href="https://github.com/openai/codex/releases/tag/rust-v0.144.6">0.144.6</a></b>',
    );
  });

  it("drops the notes blockquote when oversized, keeping the linked header", () => {
    const post = claudePost("2.1.212", "x\n".repeat(2500));
    expect(post).not.toContain("<blockquote");
    expect(post).toContain('<a href="https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21212">2.1.212</a>');
    expect(post.length).toBeLessThan(4096);
  });
});

describe("parseReleasesAtom", () => {
  it("keeps only stable rust releases from the real feed, newest first", () => {
    const releases = parseReleasesAtom(codexAtom);
    expect(releases.map((r) => r.version)).toEqual(["0.144.6"]);
    expect(releases[0].url).toBe("https://github.com/openai/codex/releases/tag/rust-v0.144.6");
  });

  it("converts the release body to plain text without tags or entities", () => {
    const [release] = parseReleasesAtom(codexAtom);
    expect(release.notes).toMatch(/^Bug Fixes\n- Refreshed bundled instructions/);
    expect(release.notes).not.toMatch(/<|&lt;|&amp;/);
  });
});

describe("htmlToText", () => {
  it("flattens lists and strips tags, decoding entities last", () => {
    expect(htmlToText("<h2>Fixes</h2>\n<ul>\n<li>a &amp; <code>b</code></li>\n<li>c</li>\n</ul>")).toBe(
      "Fixes\n- a & b\n- c",
    );
  });
});

describe("formatNewModelsPost", () => {
  it("lists ids as code with display name and date", () => {
    const post = formatNewModelsPost([
      {
        model: { id: "claude-fable-5", displayName: "Fable 5 <new>", createdAt: "2026-05-30T00:00:00Z" },
      },
    ]);
    expect(post).toContain("<b>New models in the Anthropic API</b>");
    expect(post).toContain("• <code>claude-fable-5</code> — Fable 5 &lt;new&gt; (2026-05-30)");
    expect(post).not.toContain('<a href');
  });

  it("appends a press release section with linked title and bullets", () => {
    const post = formatNewModelsPost([
      {
        model: { id: "claude-fable-5", displayName: "Fable 5", createdAt: "" },
        press: {
          url: "https://www.anthropic.com/news/claude-fable-5-mythos-5",
          title: "Introducing Claude Fable 5",
          bullets: ["ships `claude-fable-5`"],
          photos: [],
        },
      },
    ]);
    expect(post).toContain("• <code>claude-fable-5</code> — Fable 5\n");
    expect(post).toContain(
      '<b><a href="https://www.anthropic.com/news/claude-fable-5-mythos-5">Introducing Claude Fable 5</a></b>\n• ships <code>claude-fable-5</code>',
    );
  });
});

describe("isDatedSnapshot", () => {
  it("detects trailing date suffixes only", () => {
    expect(isDatedSnapshot("claude-haiku-4-5-20251001")).toBe(true);
    expect(isDatedSnapshot("claude-haiku-4-5")).toBe(false);
    expect(isDatedSnapshot("claude-fable-5")).toBe(false);
  });
});

describe("findPressRelease", () => {
  const page = (title: string) =>
    `<html><head><title>${title} \\ Anthropic</title></head><body><article><p>Body text</p></article></body></html>`;

  it("uses the direct /news/<alias> slug when it resolves", async () => {
    const press = await findPressRelease("claude-opus-4-8", async (url) =>
      url === "https://www.anthropic.com/news/claude-opus-4-8" ? page("Introducing Claude Opus 4.8") : null,
    );
    expect(press).toEqual({
      url: "https://www.anthropic.com/news/claude-opus-4-8",
      title: "Introducing Claude Opus 4.8",
      text: "Body text",
      images: [],
    });
  });

  const sitemapEntry = (slug: string, lastmod: string) =>
    `<url><loc>https://www.anthropic.com${slug}</loc><lastmod>${lastmod}</lastmod></url>`;

  it("falls back to the sitemap for family-launch slugs, preferring fresh lastmod", async () => {
    const sitemap =
      sitemapEntry("/news/redeploying-fable-5", "2026-07-01") +
      sitemapEntry("/news/fable-safeguards", "2026-06-01") +
      sitemapEntry("/news/claude-fable-5-hardening", "2026-01-01") +
      sitemapEntry("/news/claude-fable-5-mythos-5", "2026-05-30");
    const press = await findPressRelease("claude-fable-5", async (url) => {
      if (url === "https://www.anthropic.com/sitemap.xml") return sitemap;
      if (url === "https://www.anthropic.com/news/claude-fable-5-mythos-5") return page("Introducing Fable 5");
      return null;
    });
    expect(press?.url).toBe("https://www.anthropic.com/news/claude-fable-5-mythos-5");
    expect(press?.title).toBe("Introducing Fable 5");
  });

  it("matches bare claude-<major> family slugs and gives up cleanly", async () => {
    const press = await findPressRelease("claude-opus-4", async (url) => {
      if (url === "https://www.anthropic.com/sitemap.xml") return sitemapEntry("/news/claude-4", "2025-05-22");
      if (url === "https://www.anthropic.com/news/claude-4") return page("Introducing Claude 4");
      return null;
    });
    expect(press?.url).toBe("https://www.anthropic.com/news/claude-4");
    expect(await findPressRelease("claude-opus-4", async () => null)).toBeNull();
  });
});

describe("articleImages", () => {
  it("skips the hero, dedupes, absolutizes and decodes srcSet URLs, keeps alts", () => {
    const page =
      "<article>" +
      '<img alt="hero" class="x__heroImage" srcSet="/_next/image?url=hero&amp;w=2880 1x"/>' +
      '<img alt="Benchmark table" srcSet="/_next/image?url=chart&amp;w=2600&amp;q=75 1x, /_next/image?url=chart&amp;w=1080 2x"/>' +
      '<img alt="dup" srcSet="/_next/image?url=chart&amp;w=2600&amp;q=75 1x"/>' +
      '<img srcSet="/_next/image?url=graph&amp;w=1920 1x"/>' +
      "</article>";
    expect(articleImages(page)).toEqual([
      { url: "https://www.anthropic.com/_next/image?url=chart&w=2600&q=75", alt: "Benchmark table" },
      { url: "https://www.anthropic.com/_next/image?url=graph&w=1920", alt: "" },
    ]);
    expect(articleImages("<article><p>no images</p></article>")).toEqual([]);
  });
});

describe("parseRss", () => {
  it("parses items with CDATA fields from the real feed", () => {
    const items = parseRss(openaiRss);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: "A scorecard for the AI age",
      link: "https://openai.com/index/a-scorecard-for-the-ai-age",
      description:
        "Sarah Friar, CFO of OpenAI, introduces a practical AI scorecard to measure ROI through useful work, cost per successful task, dependability, and return on compute.",
      guid: "https://openai.com/index/a-scorecard-for-the-ai-age",
      published: Date.parse("Fri, 17 Jul 2026 10:00:00 GMT"),
      category: "Company",
    });
  });
});

describe("formatOpenAiModelPost", () => {
  it("links the title and escapes text", () => {
    const post = formatOpenAiModelPost({
      title: "Introducing GPT-6 <beta>",
      link: "https://openai.com/index/introducing-gpt-6",
      description: "Bigger & better.",
      guid: "g",
      published: Date.parse("Fri, 31 Jul 2026 15:00:00 GMT"),
      category: "Product",
    });
    expect(post).toBe(
      '<b>OpenAI: <a href="https://openai.com/index/introducing-gpt-6">Introducing GPT-6 &lt;beta&gt;</a></b>\n\nBigger &amp; better.',
    );
  });
});

describe("articleText / pageTitle", () => {
  it("extracts flattened article text and a trimmed title", () => {
    const page =
      "<html><head><title>Introducing X \\ Anthropic</title></head>" +
      "<body><nav>skip</nav><article><script>var x;</script><p>Hello &amp; <b>world</b></p></article></body></html>";
    expect(articleText(page)).toBe("Hello & world");
    expect(pageTitle(page)).toBe("Introducing X");
    expect(articleText("<html><body>no article</body></html>")).toBeNull();
  });
});

describe("changelogAnchorUrl", () => {
  it("strips dots from the version anchor", () => {
    expect(changelogAnchorUrl("2.1.212")).toBe(
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21212",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes the three HTML-significant characters", () => {
    expect(escapeHtml("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });
});

describe("formatInline", () => {
  it("converts backtick pairs to <code> after escaping", () => {
    expect(formatInline("set `A<B` via `--x`")).toBe("set <code>A&lt;B</code> via <code>--x</code>");
  });

  it("leaves an unpaired backtick alone", () => {
    expect(formatInline("stray ` tick")).toBe("stray ` tick");
  });
});
