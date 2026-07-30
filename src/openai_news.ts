import { TIER_CRITERIA, type Tier } from "./blogs";
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
    items.push({ title: field("title"), link: field("link"), description: field("description"), guid });
  }
  return items;
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
