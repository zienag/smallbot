import { type Validators, conditionalFetch } from "./conditional";
import { BOT_UA, type PageMemo, articleText, pageLinks, pageTitle } from "./html";
import { structuredFromPrompt } from "./summarize";
import { escapeHtml, formatInline } from "./telegram";

export const ANTHROPIC_BLOG_SEEN_KEY = "anthropic_blog_seen";
const ARTICLE_TEXT_LIMIT = 12000;

// Neither claude.com nor anthropic.com has RSS; the index pages are
// server-rendered HTML, so they are both the trigger and the article source.
// An index only lists recent posts, but at one tick per 15 minutes nothing
// rotates out unseen. Every source posts to the same channel.
export interface BlogIndex {
  source: string; // signs the post footer
  indexUrl: string;
  base: string;
  hrefPrefix: string; // post links on the index page are base-relative under this
  // The index also links articles that live outside the prefix; each such link
  // is opened once and judged by what the page itself is (probeArticle).
  probeOffPrefix?: boolean;
}

export const BLOG_INDEXES: BlogIndex[] = [
  {
    source: "Claude Blog",
    indexUrl: "https://claude.com/blog",
    base: "https://claude.com",
    hrefPrefix: "/blog/",
  },
  {
    source: "Anthropic News",
    indexUrl: "https://www.anthropic.com/news",
    base: "https://www.anthropic.com",
    hrefPrefix: "/news/",
    probeOffPrefix: true,
  },
  {
    source: "Anthropic Engineering",
    indexUrl: "https://www.anthropic.com/engineering",
    base: "https://www.anthropic.com",
    hrefPrefix: "/engineering/",
  },
];

export interface BlogEntry {
  url: string;
  source: string;
  probe?: true; // outside the index's prefix: an article only if its page says so
}

/** Same window as the other watches: an article dated older than this is not news. */
export const MAX_BLOG_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Links of an index page, in page order (newest first), deduped. A link under
 * the index's prefix is a post. anthropic.com/news also features articles that
 * live elsewhere — every model launch since Fable 5.1 (/claude-fable-and-
 * mythos-5-1, /claude-opus-5-5) — between links to the rest of the site, and
 * nothing in the index's markup tells the two apart: the cards were dated
 * until the dates were dropped, the address was relative until the featured
 * one was written in full (2026-11-09, the Fable 5.2 launch never reached the
 * channel). So those come back marked `probe`, for the page to speak for itself.
 */
export function parseIndexLinks(index: BlogIndex, html: string): BlogEntry[] {
  const out: BlogEntry[] = [];
  for (const { url } of pageLinks(html, index.base)) {
    if (url === index.base || url === index.indexUrl) continue;
    if (url.startsWith(index.base + index.hrefPrefix)) out.push({ url, source: index.source });
    else if (index.probeOffPrefix) out.push({ url, source: index.source, probe: true });
  }
  return out;
}

/**
 * Entries of every index that changed since its last fully processed read; an
 * unchanged index (a 304 — claude.com sends Last-Modified, anthropic.com
 * nothing, so it is always re-read) contributes none. Null when no index
 * changed. An index another watch already downloaded this tick is taken from
 * `pages`.
 */
export async function fetchAllBlogEntries(validators?: Validators, pages?: PageMemo): Promise<BlogEntry[] | null> {
  const out: BlogEntry[] = [];
  let changed = false;
  for (const index of BLOG_INDEXES) {
    let html = pages?.get(index.indexUrl);
    if (html === undefined) {
      const res = await conditionalFetch(index.indexUrl, validators, { "User-Agent": BOT_UA });
      if (!res) continue;
      if (!res.ok) throw new Error(`${index.source} index fetch failed: ${res.status}`);
      html = await res.text();
    }
    changed = true;
    out.push(...parseIndexLinks(index, html));
  }
  return changed ? out : null;
}

const PROBE_TEXT_LIMIT = 3000;

const PROBE_PROMPT = (url: string, title: string, text: string) => `\
A Telegram channel reposts every new article Anthropic publishes. Anthropic's \
news page links the page below, which sits outside the news section: it may be \
an article in its own right (a model launch, a research post, a feature story) \
or just a part of the site (a product page, a hub or team page listing other \
posts, search, legal, careers).

Address: ${url}
Title: ${title}
The start of its text (extracted from the page, may contain navigation noise):
${text}

Is this page itself one article or announcement? And what publication date \
does the page state for itself, as YYYY-MM-DD? Leave the date empty when the \
page states none: it is compared with today to decide whether the article is \
new, so a guessed date would repost something old.`;

const PROBE_SCHEMA = {
  type: "object",
  properties: { article: { type: "boolean" }, published: { type: "string" } },
  required: ["article", "published"],
  additionalProperties: false,
};

/**
 * What an off-prefix link turned out to be: a recent article (with its page,
 * so the digest does not download it again), something to absorb into the
 * seen-set for good (not an article, undated, old, gone), or a page that did
 * not answer and is asked again next tick.
 */
export async function probeArticle(
  apiKey: string,
  kv: KVNamespace,
  url: string,
  now: number,
): Promise<{ page: string } | "absorb" | "retry"> {
  // A redirect is a download or another site (/press-kit), never an article.
  const res = await fetch(url, { headers: { "User-Agent": BOT_UA }, redirect: "manual" });
  if (res.status >= 500 || res.status === 429) return "retry";
  if (!res.ok) return "absorb";
  const page = await res.text();
  const text = articleText(page);
  if (!text) return "absorb";
  const verdict = await structuredFromPrompt<{ article: boolean; published: string }>(
    apiKey,
    kv,
    PROBE_PROMPT(url, pageTitle(page) ?? "", text.slice(0, PROBE_TEXT_LIMIT)),
    PROBE_SCHEMA,
    "haiku",
  );
  const published = /^\d{4}-\d{2}-\d{2}$/.test(verdict.published) ? Date.parse(verdict.published) : Number.NaN;
  if (!verdict.article || Number.isNaN(published) || now - published > MAX_BLOG_AGE_MS) return "absorb";
  return { page };
}

// Importance drives delivery: major is pinned, minor posts without sound.
export type Tier = "major" | "normal" | "minor";

// Shared with the OpenAI blog watch — the channels mirror each other.
export const TIER_CRITERIA = `\
- "major": a new AI model release; the launch of a new consumer product an \
individual person can pick up and use (a new app or tool — think Claude Code \
or Claude Design), NOT an enterprise/B2B/API-platform launch however big; or \
potential breaking news — an incident or event with a real chance of making \
waves beyond the AI community (a serious security incident, model misbehavior \
in the wild, a lawsuit, a major outage).
- "normal": notable updates to existing consumer products, engineering \
deep-dives, significant research findings.
- "minor": customer case studies, partnerships, enterprise/B2B launches and \
features, policy posts, marketing, hiring, events.`;

export interface BlogDigest {
  title: string;
  tier: Tier;
  bullets: string[];
  minutes: number | null;
}

/** Words per minute of prose, the figure the read-time counters everyone knows use. */
const WPM = 220;

/** Read time in whole minutes, floor 1; null when the article text never reached us. */
export function readMinutes(text: string | null): number | null {
  if (!text) return null;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words === 0 ? null : Math.max(1, Math.round(words / WPM));
}

// Split so the two prompts differ only in where the article comes from.
// Also shared with the YouTube watch, whose article is a video description.
export const DIGEST_TASK = `\
Pick the 2-4 points an engineer would actually care about: concrete \
capabilities, numbers, and takeaways, not marketing framing. Each bullet is \
one short sentence. Wrap commands, flags, and other identifiers in backticks. \
Write in English.

Also assign the post an importance tier:
${TIER_CRITERIA}`;

const DIGEST_HEAD = (source: string, title: string) => `\
You are writing a short digest of a post from ${source} for a Telegram channel \
whose readers are engineers who follow AI news daily.

Post title: ${title}`;

const DIGEST_PROMPT = (source: string, title: string, text: string) => `\
${DIGEST_HEAD(source, title)}

Post text (extracted from the page, may contain navigation noise):
${text}

${DIGEST_TASK}`;

const DIGEST_URL_PROMPT = (source: string, title: string, url: string) => `\
${DIGEST_HEAD(source, title)}

Fetch ${url} and digest the article on that page.

${DIGEST_TASK}`;

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["major", "normal", "minor"] },
    bullets: { type: "array", items: { type: "string" } },
  },
  required: ["tier", "bullets"],
  additionalProperties: false,
};

/**
 * Same digest, but the model fetches the page itself. For openai.com, whose bot
 * protection blocks our own fetch for hours at a time (see src/openai_news.ts);
 * costs ~7.6¢ against ~2¢, so it is the fallback, not the path.
 */
export async function digestArticleByUrl(
  apiKey: string,
  kv: KVNamespace,
  source: string,
  title: string,
  url: string,
): Promise<{ tier: Tier; bullets: string[]; minutes: number | null }> {
  const digest = await structuredFromPrompt<{ tier: Tier; bullets: string[] }>(
    apiKey,
    kv,
    DIGEST_URL_PROMPT(source, title, url),
    DIGEST_SCHEMA,
    "opus",
    true,
  );
  // The model read the page, we never saw it: no word count, so no read time.
  return { tier: digest.tier, bullets: digest.bullets.slice(0, 4), minutes: null };
}

/** Shared with the OpenAI blog watch, which gets its article text elsewhere. */
export async function digestArticle(
  apiKey: string,
  kv: KVNamespace,
  source: string,
  title: string,
  text: string,
): Promise<{ tier: Tier; bullets: string[]; minutes: number | null }> {
  const digest = await structuredFromPrompt<{ tier: Tier; bullets: string[] }>(
    apiKey,
    kv,
    DIGEST_PROMPT(source, title, text.slice(0, ARTICLE_TEXT_LIMIT)),
    DIGEST_SCHEMA,
  );
  // Counted on the whole article, not the slice the prompt gets.
  return { tier: digest.tier, bullets: digest.bullets.slice(0, 4), minutes: readMinutes(text) };
}

export async function digestBlogPost(
  apiKey: string,
  kv: KVNamespace,
  entry: BlogEntry,
  page?: string,
): Promise<BlogDigest> {
  if (page === undefined) {
    const res = await fetch(entry.url, { headers: { "User-Agent": BOT_UA } });
    if (!res.ok) throw new Error(`blog post fetch failed: ${res.status} ${entry.url}`);
    page = await res.text();
  }
  const title = pageTitle(page) ?? entry.url;
  const digest = await digestArticle(
    apiKey,
    kv,
    entry.source,
    title,
    articleText(page) ?? title,
  );
  return { title, ...digest };
}

export function bulletList(bullets: string[]): string {
  return bullets.map((b) => `• ${formatInline(b)}`).join("\n");
}

/**
 * The shape every blog channel post shares: the title leads, the source signs
 * off at the bottom. Telegram's HTML has no colour, so the footer is italic —
 * the quietest register the Bot API offers.
 */
export function buildArticlePost(article: {
  url: string;
  title: string;
  body: string;
  source: string;
  minutes: number | null;
}): string {
  const head = `<b><a href="${article.url}">${escapeHtml(article.title)}</a></b>`;
  const read = article.minutes === null ? "" : ` · ${article.minutes} min read`;
  const footer = `<i>${escapeHtml(article.source)}${read}</i>`;
  return [head, article.body, footer].filter(Boolean).join("\n\n");
}

export function formatBlogPost(entry: BlogEntry, digest: BlogDigest): string {
  return buildArticlePost({
    url: entry.url,
    title: digest.title,
    body: bulletList(digest.bullets),
    source: entry.source,
    minutes: digest.minutes,
  });
}
