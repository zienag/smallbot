import { describe, expect, it } from "vitest";
import { BLOG_INDEXES, formatBlogPost, parseIndexLinks, readMinutes } from "../src/blogs";
import { articleText } from "../src/html";

const claudeBlog = BLOG_INDEXES[0];

describe("parseIndexLinks", () => {
  it("extracts post links in page order, deduped, absolute", () => {
    expect(parseIndexLinks(claudeBlog, INDEX_HTML).map((e) => e.url)).toEqual([
      "https://claude.com/blog/newest-post",
      "https://claude.com/blog/older-post",
    ]);
  });

  it("tags entries with the index source", () => {
    expect(parseIndexLinks(claudeBlog, INDEX_HTML)[0].source).toBe("Claude Blog");
  });

  it("skips the index self-link, locales, and query links", () => {
    const urls = parseIndexLinks(claudeBlog, INDEX_HTML).map((e) => e.url);
    expect(urls).not.toContain("https://claude.com/blog");
    expect(urls.some((u) => u.includes("/ja/") || u.includes("?"))).toBe(false);
  });

  // 2026-11-09: the featured card of the Fable 5.2 launch had its address
  // written in full and no date, and the launch never reached the channel.
  it("marks what the news index links outside its section for a look at the page itself", () => {
    const news = BLOG_INDEXES[1];
    const html = `
      <a href="/news">News</a>
      <a href="https://www.anthropic.com/claude-fable-and-mythos-5-2"><h2>Introducing Claude Fable 5.2</h2></a>
      <a href="/news/s1-sec">Anthropic files S-1</a>
      <a href="/science">Science</a>
      <a href="https://x.com/AnthropicAI">X</a>`;
    expect(parseIndexLinks(news, html)).toEqual([
      { url: "https://www.anthropic.com/claude-fable-and-mythos-5-2", source: "Anthropic News", probe: true },
      { url: "https://www.anthropic.com/news/s1-sec", source: "Anthropic News" },
      { url: "https://www.anthropic.com/science", source: "Anthropic News", probe: true },
    ]);
  });
});

describe("formatBlogPost", () => {
  const entry = { url: "https://claude.com/blog/a-post", source: "Claude Blog" };

  it("renders a linked title, inline-formatted bullets and the source footer", () => {
    const post = formatBlogPost(entry, {
      title: "A <new> post",
      tier: "normal",
      bullets: ["Adds `--flag` support", "2x faster"],
      minutes: 5,
    });
    expect(post).toBe(
      '<b><a href="https://claude.com/blog/a-post">A &lt;new&gt; post</a></b>\n\n' +
        "• Adds <code>--flag</code> support\n• 2x faster\n\n" +
        "<i>Claude Blog · 5 min read</i>",
    );
  });

  it("drops the read time when the article text never arrived", () => {
    const post = formatBlogPost(entry, {
      title: "T",
      tier: "minor",
      bullets: ["One point"],
      minutes: null,
    });
    expect(post).toBe(
      '<b><a href="https://claude.com/blog/a-post">T</a></b>\n\n' +
        "• One point\n\n<i>Claude Blog</i>",
    );
  });

  it("degrades to title and footer without bullets", () => {
    const post = formatBlogPost(entry, { title: "T", tier: "minor", bullets: [], minutes: 1 });
    expect(post).toBe(
      '<b><a href="https://claude.com/blog/a-post">T</a></b>\n\n<i>Claude Blog · 1 min read</i>',
    );
  });
});

describe("readMinutes", () => {
  it("rounds to whole minutes with a floor of one", () => {
    expect(readMinutes(null)).toBeNull();
    expect(readMinutes("   ")).toBeNull();
    expect(readMinutes("one two three")).toBe(1);
    expect(readMinutes(Array(2128).fill("word").join(" "))).toBe(10);
  });
});

describe("articleText on the launch template", () => {
  it("takes the whole main and drops the customer-quote articles", () => {
    const page = `<main><article><p>We’re introducing X.</p></article>
      <section><h2>Scientific research</h2><p>Body outside any article.</p><svg><text>chart</text></svg></section>
      <article><p>Quote “Loved it.”</p><p>Company</p></article>
      <article><p>Quote “Great.”</p></article>
      <h2>Cost and availability</h2><p>Price drops.</p></main>`;
    expect(articleText(page)).toBe(
      "We’re introducing X. Scientific research Body outside any article. Cost and availability Price drops.",
    );
  });
});

describe("articleText main fallback", () => {
  it("falls back to <main> when there is no <article>", () => {
    expect(articleText('<body><main class="x"><p>Post body</p></main></body>')).toBe("Post body");
  });

  it("prefers <article> over <main>", () => {
    expect(articleText("<main>outer <article><p>inner</p></article> tail</main>")).toBe("inner");
  });
});

const INDEX_HTML = `
<nav><a href="/blog">Blog</a><a href="/ja/blog/newest-post">ja</a></nav>
<main>
  <a href="/blog/newest-post">Newest</a>
  <a href="/blog/older-post">Older</a>
  <a href="/blog/newest-post">Newest again</a>
  <a href="/blog?page=2">Next page</a>
  <a href="/pricing">Pricing</a>
</main>`;
