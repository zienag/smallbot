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
  source: string; // post header prefix
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
}

/** Post links from an index page, in page order (newest first), deduped. */
export function parseIndexLinks(index: BlogIndex, html: string): BlogEntry[] {
  const out: BlogEntry[] = [];
  const seen = new Set<string>();
  for (const [, href] of html.matchAll(/href="(\/[^"#?]+)"/g)) {
    if (!href.startsWith(index.hrefPrefix)) continue;
    const url = index.base + href;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, source: index.source });
  }
  return out;
}

export async function fetchAllBlogEntries(): Promise<BlogEntry[]> {
  const out: BlogEntry[] = [];
  for (const index of BLOG_INDEXES) {
    const res = await fetch(index.indexUrl, { headers: { "User-Agent": BOT_UA } });
    if (!res.ok) throw new Error(`${index.source} index fetch failed: ${res.status}`);
    out.push(...parseIndexLinks(index, await res.text()));
  }
  return out;
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
}

const DIGEST_PROMPT = (source: string, title: string, text: string) => `\
You are writing a short digest of a post from ${source} for a Telegram channel \
whose readers are engineers who follow AI news daily.

Post title: ${title}

Post text (extracted from the page, may contain navigation noise):
${text}

Pick the 2-4 points an engineer would actually care about: concrete \
capabilities, numbers, and takeaways, not marketing framing. Each bullet is \
one short sentence. Wrap commands, flags, and other identifiers in backticks. \
Write in English.

Also assign the post an importance tier:
${TIER_CRITERIA}`;

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["major", "normal", "minor"] },
    bullets: { type: "array", items: { type: "string" } },
  },
  required: ["tier", "bullets"],
  additionalProperties: false,
};

export async function digestBlogPost(
  apiKey: string,
  kv: KVNamespace,
  entry: BlogEntry,
): Promise<BlogDigest> {
  const res = await fetch(entry.url, { headers: { "User-Agent": BOT_UA } });
  if (!res.ok) throw new Error(`blog post fetch failed: ${res.status} ${entry.url}`);
  const page = await res.text();
  const title = pageTitle(page) ?? entry.url;
  const text = (articleText(page) ?? title).slice(0, ARTICLE_TEXT_LIMIT);
  const digest = await structuredFromPrompt<{ tier: Tier; bullets: string[] }>(
    apiKey,
    kv,
    DIGEST_PROMPT(entry.source, title, text),
    DIGEST_SCHEMA,
  );
  return { title, tier: digest.tier, bullets: digest.bullets.slice(0, 4) };
}

export function formatBlogPost(entry: BlogEntry, digest: BlogDigest): string {
  const head = `<b>${escapeHtml(entry.source)}: <a href="${entry.url}">${escapeHtml(digest.title)}</a></b>`;
  if (digest.bullets.length === 0) return head;
  return `${head}\n\n${digest.bullets.map((b) => `• ${formatInline(b)}`).join("\n")}`;
}
