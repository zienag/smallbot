import { afterEach, describe, expect, it, vi } from "vitest";
import {
  articleSlug,
  fetchNewsListSlugs,
  formatOpenAiBlogPost,
  formatOpenAiModelPost,
  isListed,
  isRecent,
  parseNewsList,
  parseRss,
} from "../src/openai_news";

describe("isListed", () => {
  const LIST = new Set(["index/advancing-responsible-ai-across-europe"]);

  it("posts what the news list carries", () => {
    const [europe] = parseRss(BACKFILL_RSS);
    expect(isListed(europe, LIST)).toBe(true);
  });

  it("drops a case page the newsroom does not list", () => {
    const [, sneer] = parseRss(BACKFILL_RSS);
    expect(isListed(sneer, LIST)).toBe(false);
  });

  it("falls back to the feed's category when the list is unreachable", () => {
    const [europe, sneer, , story] = parseRss(BACKFILL_RSS);
    expect(isListed(europe, null)).toBe(true);
    expect(isListed(sneer, null)).toBe(false);
    expect(isListed(story, null)).toBe(false);
  });
});

describe("fetchNewsListSlugs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks in English, for articles the newsroom lists", async () => {
    let asked = "";
    vi.stubGlobal("fetch", async (url: string) => {
      asked = url;
      return Response.json({ items: [{ slug: "index/a-post" }] });
    });
    expect(await fetchNewsListSlugs()).toEqual({ slugs: new Set(["index/a-post"]), via: "fetch" });
    expect(asked).toContain("locale=en-US");
    expect(asked).toContain("global-affairs-news-listed");
  });

  it("falls back to the browser when Cloudflare challenges the fetch", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    const browser = { quickAction: async () => Response.json({ success: true, result: BROWSER_MARKDOWN }) };
    expect(await fetchNewsListSlugs(browser)).toEqual({
      slugs: new Set(["index/a-post"]),
      via: "browser after fetch:403",
    });
  });

  it("has no opinion when neither rung answers", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    const browser = { quickAction: async () => new Response("nope", { status: 429 }) };
    const { slugs, via } = await fetchNewsListSlugs(browser);
    expect(slugs).toBeNull();
    expect(via).toBe("fetch:403 browser:failed");
  });

  it("has no opinion when the shape changes under it", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ items: [] }));
    expect((await fetchNewsListSlugs()).slugs).toBeNull();
  });
});

describe("parseNewsList", () => {
  it("digs the JSON out of what the browser hands back", () => {
    expect(parseNewsList(BROWSER_MARKDOWN)).toEqual(new Set(["index/a-post"]));
  });
});

describe("articleSlug", () => {
  it("matches how the news list names an article", () => {
    expect(articleSlug("https://openai.com/index/a-post")).toBe("index/a-post");
    expect(articleSlug("https://openai.com/global-affairs/a-report/")).toBe("global-affairs/a-report");
  });
});

describe("isRecent", () => {
  it("keeps what the feed just published", () => {
    expect(isRecent({ ...ITEM, published: NOW - HOUR }, NOW)).toBe(true);
  });

  it("drops the case pages OpenAI backfilled from its 2024-2025 threat reports", () => {
    const backfilled = parseRss(BACKFILL_RSS);
    expect(backfilled.map((i) => isRecent(i, NOW))).toEqual([true, false, false, true]);
  });

  it("keeps an item dated ahead of us — OpenAI publishes those", () => {
    expect(isRecent({ ...ITEM, published: NOW + 4 * DAY }, NOW)).toBe(true);
  });

  it("drops an item with no usable pubDate", () => {
    expect(isRecent({ ...ITEM, published: null }, NOW)).toBe(false);
  });
});

describe("parseRss", () => {
  it("reads pubDate as epoch ms and leaves a missing one null", () => {
    const items = parseRss(BACKFILL_RSS);
    expect(items[0].published).toBe(Date.parse("Fri, 31 Jul 2026 15:00:00 GMT"));
    expect(items[2].published).toBeNull();
  });
});

describe("formatOpenAiBlogPost", () => {
  it("renders a linked title, inline-formatted bullets and the source footer", () => {
    expect(formatOpenAiBlogPost(ITEM, ["Ships `gpt-5.5-codex`", "2x cheaper"], 7)).toBe(
      '<b><a href="https://openai.com/index/a-post">A &lt;new&gt; post</a></b>\n\n' +
        "• Ships <code>gpt-5.5-codex</code>\n• 2x cheaper\n\n<i>OpenAI · 7 min read</i>",
    );
  });

  it("falls back to the feed sentence when the article could not be read", () => {
    expect(formatOpenAiBlogPost(ITEM, [], null)).toBe(formatOpenAiModelPost(ITEM));
  });
});

const ITEM = {
  title: "A <new> post",
  link: "https://openai.com/index/a-post",
  description: "One sentence from the feed.",
  guid: "https://openai.com/index/a-post",
  published: Date.parse("Fri, 31 Jul 2026 15:00:00 GMT"),
  category: "Product",
};

// Browser Run renders the endpoint's JSON as a page, so it comes back fenced.
const BROWSER_MARKDOWN = '```json\n{"total":542,"items":[{"slug":"index/a-post"}]}\n```';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("Fri, 31 Jul 2026 18:00:00 GMT");

// A listed post of the day; two of the case pages that flooded the channel, one
// dated 2025 and one with no pubDate at all; and a customer story — recent, but
// not something the newsroom lists.
const BACKFILL_RSS = `<rss><channel>
  <item>
    <title><![CDATA[Advancing responsible AI across Europe]]></title>
    <link>https://openai.com/index/advancing-responsible-ai-across-europe</link>
    <guid isPermaLink="true">https://openai.com/index/advancing-responsible-ai-across-europe</guid>
    <category><![CDATA[Global Affairs]]></category>
    <pubDate>Fri, 31 Jul 2026 15:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Operation "Sneer Review": China-origin influence activity]]></title>
    <link>https://openai.com/index/disrupting-malicious-uses-of-ai-sneer-review</link>
    <guid isPermaLink="true">https://openai.com/index/disrupting-malicious-uses-of-ai-sneer-review</guid>
    <pubDate>Sun, 01 Jun 2025 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Scam operations: Online fraud networks]]></title>
    <link>https://openai.com/index/disrupting-malicious-uses-of-ai-scam-operations</link>
    <guid isPermaLink="true">https://openai.com/index/disrupting-malicious-uses-of-ai-scam-operations</guid>
  </item>
  <item>
    <title><![CDATA[Univé builds an AI-ready workforce]]></title>
    <link>https://openai.com/index/unive</link>
    <guid isPermaLink="true">https://openai.com/index/unive</guid>
    <pubDate>Fri, 31 Jul 2026 07:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
