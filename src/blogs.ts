import { decodeHTML } from "entities";
import { type Validators, conditionalFetch } from "./conditional";
import { BOT_UA, articleText, pageTitle } from "./html";
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
  published?: number; // epoch ms from the card's <time>, when the index dates it
}

/** Same window as the other watches: a dated card older than this is not news. */
export const MAX_BLOG_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Undated entries pass — the prefix indexes list only recent posts. */
export function isRecentEntry(entry: BlogEntry, now: number): boolean {
  return entry.published === undefined || now - entry.published <= MAX_BLOG_AGE_MS;
}

/**
 * Post links from an index page, in page order (newest first), deduped. A post
 * is a link under the index's prefix, or a card the index dates — an anchor
 * with a `<time>` inside — wherever it points: anthropic.com/news put the
 * Fable 5.1 launch in its featured card as /claude-fable-and-mythos-5-1, and
 * the prefix alone dropped it (2026-09-01). Only that index dates its cards;
 * the other two carry no `<time>` at all and rely on the prefix.
 */
export function parseIndexLinks(index: BlogIndex, html: string): BlogEntry[] {
  const out: BlogEntry[] = [];
  const seen = new Set<string>();
  for (const [, href, body] of html.matchAll(/<a\s[^>]*href="(\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const time = body.match(/<time[^>]*>([^<]*)<\/time>/);
    if (!href.startsWith(index.hrefPrefix) && !time) continue;
    const url = index.base + href;
    if (seen.has(url)) continue;
    seen.add(url);
    const published = time ? Date.parse(decodeHTML(time[1]).trim()) : Number.NaN;
    out.push({ url, source: index.source, ...(Number.isNaN(published) ? {} : { published }) });
  }
  return out;
}

/**
 * Entries of every index that changed since its last fully processed read; an
 * unchanged index (a 304 — claude.com sends Last-Modified, anthropic.com
 * nothing, so it is always re-read) contributes none. Null when no index changed.
 */
export async function fetchAllBlogEntries(validators?: Validators): Promise<BlogEntry[] | null> {
  const out: BlogEntry[] = [];
  let changed = false;
  for (const index of BLOG_INDEXES) {
    const res = await conditionalFetch(index.indexUrl, validators, { "User-Agent": BOT_UA });
    if (!res) continue;
    if (!res.ok) throw new Error(`${index.source} index fetch failed: ${res.status}`);
    changed = true;
    out.push(...parseIndexLinks(index, await res.text()));
  }
  return changed ? out : null;
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
): Promise<BlogDigest> {
  const res = await fetch(entry.url, { headers: { "User-Agent": BOT_UA } });
  if (!res.ok) throw new Error(`blog post fetch failed: ${res.status} ${entry.url}`);
  const page = await res.text();
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
