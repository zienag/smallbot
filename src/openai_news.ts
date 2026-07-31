import { TIER_CRITERIA, type Tier } from "./blogs";
import { type BrowserRun, fetchPageMarkdown } from "./browser";
import { structuredFromPrompt } from "./summarize";
import { escapeHtml, formatInline } from "./telegram";

// The RSS is the one thing on openai.com a worker can always fetch; article
// pages answer 403 for hours at a stretch, so their text comes from the model's
// own fetch (see digestArticleByUrl).
export const OPENAI_RSS_URL = "https://openai.com/news/rss.xml";
export const OPENAI_BLOG_SEEN_KEY = "openai_blog_seen";

export interface NewsItem {
  title: string;
  link: string;
  description: string;
  guid: string;
  published: number | null; // epoch ms from <pubDate>
  category: string; // "" on the pages the news index does not list
}

/** Feed order: newest first. The feed contains the entire history. */
export function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name: string) => {
      const m = item.match(
        new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`),
      );
      return m?.[1].trim() ?? "";
    };
    const guid = field("guid") || field("link");
    if (!guid) continue;
    const published = Date.parse(field("pubDate"));
    items.push({
      title: field("title"),
      link: field("link"),
      description: field("description"),
      guid,
      published: Number.isNaN(published) ? null : published,
      category: field("category"),
    });
  }
  return items;
}

/**
 * The feed is not append-only. On 2026-07-31 OpenAI backfilled the case pages
 * of its old "Disrupting malicious uses of AI" reports — dated 2024 and 2025 —
 * and the channel posted nineteen of them in half an hour, because membership
 * in the seen-set was the only thing standing for novelty. Publication date is
 * the second signal: whatever the feed gains, only recent items are news.
 * Generous by design — the cron runs every 15 minutes, so a real item is never
 * anywhere near this old by the time we see it.
 */
export const MAX_ITEM_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * An undated item counts as stale: every one of the feed's ~1100 entries
 * carries a pubDate, so a missing one says the item is not what we think it
 * is, and a flood cannot be taken back (a bot can only delete its own posts
 * for 48 hours) while a missed item can still be force-posted by hand.
 */
export function isRecent(item: NewsItem, now: number): boolean {
  return item.published !== null && now - item.published <= MAX_ITEM_AGE_MS;
}

/**
 * What openai.com/news actually lists, from the endpoint its "Load more" button
 * calls. The feed is every page the site has ever published — 1104 entries
 * against this list's 542 — so it carries things the newsroom does not show:
 * the case pages of the threat reports, and the customer stories. Reading the
 * list is reading OpenAI's own editorial choice instead of guessing at it.
 *
 * Locale is a parameter, and it decides the language of the titles, so it is
 * pinned: unpinned, the answer follows the caller's IP and the channel is
 * English. The categories are the ones the page itself asks for, verbatim —
 * note `global-affairs-news-listed` rather than plain `global-affairs`, which
 * is how the site keeps some policy posts out of the newsroom.
 */
export const OPENAI_ARTICLES_URL = "https://openai.com/backend/articles/";

const NEWS_LIST_CATEGORIES = [
  "company",
  "research",
  "product",
  "engineering",
  "safety",
  "security",
  "ai-adoption",
  "applied-ai",
  "global-affairs-news-listed",
];

// Same Cloudflare challenge as the article pages: no UA at all answers 403
// `cf-mitigated: challenge`, a real browser's UA passes. See docs/openai-access.md
// — a plain fetch is not guaranteed to hold, which is why the caller has a
// fallback and why this runs only when there is something to post.
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** `index/<slug>` — how the news list names an article, and what its feed link ends with. */
export function articleSlug(link: string): string {
  return link.replace(/^https?:\/\/openai\.com\//, "").replace(/\/+$/, "");
}

export function newsListUrl(limit: number): string {
  const params = new URLSearchParams({
    locale: "en-US",
    pageQueries: JSON.stringify([{ pageTypes: ["Article"], categories: NEWS_LIST_CATEGORIES }]),
    limit: String(limit),
    skip: "0",
    sort: "new",
  });
  return `${OPENAI_ARTICLES_URL}?${params}`;
}

/** The endpoint answers JSON; through the browser it arrives wrapped in the page's markdown. */
export function parseNewsList(body: string): Set<string> | null {
  const json = body.startsWith("{") ? body : body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(json) as { items?: { slug?: string }[] };
    const slugs = (parsed.items ?? []).map((i) => i.slug).filter((s): s is string => !!s);
    // An empty list is a shape change, not an empty newsroom: no opinion either way.
    return slugs.length > 0 ? new Set(slugs) : null;
  } catch {
    return null;
  }
}

/**
 * Slugs of the newest entries of the news list. `slugs: null` means "no
 * opinion" — Cloudflare shut us out — not "nothing is listed". `via` says which
 * rung answered, the way the digest reports its own.
 */
export async function fetchNewsListSlugs(
  browser?: BrowserRun,
  limit = 30,
): Promise<{ slugs: Set<string> | null; via: string }> {
  const url = newsListUrl(limit);
  let via = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": CHROME_UA, Accept: "application/json" } });
    if (res.ok) {
      const slugs = parseNewsList(await res.text());
      if (slugs) return { slugs, via: "fetch" };
      via = "fetch:unparsable";
    } else {
      via = `fetch:${res.status}`;
    }
  } catch (err) {
    via = `fetch:${err}`;
  }
  // The browser solves the challenge that the fetch above cannot, and this runs
  // rarely enough to afford one quick action.
  if (browser) {
    const markdown = await fetchPageMarkdown(browser, url);
    const slugs = markdown ? parseNewsList(markdown) : null;
    // Carry why the cheap rung lost, or the reason is invisible from outside.
    if (slugs) return { slugs, via: `browser after ${via}` };
    via += markdown ? " browser:unparsable" : " browser:failed";
  }
  console.log(`openai news list unavailable: ${via}`);
  return { slugs: null, via };
}

/**
 * Is the item one the newsroom lists? The list is the authority; when it is
 * unreachable the feed's own `<category>` stands in for it — every case page
 * and every customer story comes through without one, which is the same cut
 * the list makes, give or take the policy posts.
 */
export function isListed(item: NewsItem, listed: Set<string> | null): boolean {
  return listed ? listed.has(articleSlug(item.link)) : item.category !== "";
}

export async function fetchOpenAiNews(): Promise<NewsItem[]> {
  const res = await fetch(OPENAI_RSS_URL);
  if (!res.ok) throw new Error(`openai rss fetch failed: ${res.status}`);
  return parseRss(await res.text());
}


// Used when the article could not be read at all: the tier still tunes
// delivery (pin / sound / silent) off the feed's one-sentence description.
const TIER_PROMPT = (item: NewsItem) => `\
You are triaging an item from the OpenAI news feed for a Telegram channel \
whose readers are engineers who follow AI news daily. Only the title and \
description are available.

Title: ${item.title}
Description: ${item.description}

Assign the item an importance tier:
${TIER_CRITERIA}`;

export async function classifyTier(
  apiKey: string,
  kv: KVNamespace,
  item: NewsItem,
): Promise<Tier> {
  const verdict = await structuredFromPrompt<{ tier: Tier }>(apiKey, kv, TIER_PROMPT(item), {
    type: "object",
    properties: { tier: { type: "string", enum: ["major", "normal", "minor"] } },
    required: ["tier"],
    additionalProperties: false,
  });
  return verdict.tier;
}

export function formatOpenAiModelPost(item: NewsItem): string {
  return `<b>OpenAI: <a href="${item.link}">${escapeHtml(item.title)}</a></b>\n\n${escapeHtml(item.description)}`;
}

/** Same shape as the Anthropic blog post; falls back to the feed sentence. */
export function formatOpenAiBlogPost(item: NewsItem, bullets: string[]): string {
  if (bullets.length === 0) return formatOpenAiModelPost(item);
  const head = `<b>OpenAI: <a href="${item.link}">${escapeHtml(item.title)}</a></b>`;
  return `${head}\n\n${bullets.map((b) => `• ${formatInline(b)}`).join("\n")}`;
}
