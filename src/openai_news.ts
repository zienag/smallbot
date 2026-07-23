import { TIER_CRITERIA, type Tier } from "./blogs";
import { structuredFromPrompt } from "./summarize";
import { escapeHtml } from "./telegram";

// openai.com pages are bot-blocked (403 even with a browser UA); only the
// RSS is open — it is both the trigger and the post content.
export const OPENAI_RSS_URL = "https://openai.com/news/rss.xml";
export const OPENAI_SEEN_KEY = "openai_news_seen";
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

// Feed categories are inconsistent ("Introducing GPT-5" is Release,
// "Introducing GPT-5.5" is Product), so the filter is an LLM, not the category.
const CLASSIFY_PROMPT = (item: NewsItem) => `\
You are filtering the OpenAI news feed for a Telegram channel that announces \
new AI model releases.

News item:
Title: ${item.title}
Description: ${item.description}

Decide whether this item announces the release, preview, or general \
availability of a new AI model or model version (a new GPT, Codex model, \
o-series, image/audio/video model, etc). System cards, research done with a \
model, partnerships, integrations ("X now available on Y"), customer stories, \
app/product features, pricing changes, and policy posts do NOT count.`;

export async function isModelRelease(
  apiKey: string,
  kv: KVNamespace,
  item: NewsItem,
): Promise<boolean> {
  const verdict = await structuredFromPrompt<{ isModelRelease: boolean }>(
    apiKey,
    kv,
    CLASSIFY_PROMPT(item),
    {
      type: "object",
      properties: { isModelRelease: { type: "boolean" } },
      required: ["isModelRelease"],
      additionalProperties: false,
    },
  );
  return verdict.isModelRelease;
}

// The blog channel reposts every feed item; the tier only tunes delivery
// (pin / sound / silent). Title+description is all we have — pages are blocked.
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
