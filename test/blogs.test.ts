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
