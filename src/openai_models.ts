import type { Candidate } from "./announcement";
import { type HnStory, canonicalArticleUrl } from "./hn";
import type { NewsItem } from "./openai_news";
import { escapeHtml, formatInline } from "./telegram";

export const OPENAI_KNOWN_MODELS_KEY = "openai_known_models";
export const OPENAI_MODEL_FOLLOWUPS_KEY = "openai_model_followups";
const MODELS_URL = "https://api.openai.com/v1/models";

export interface OpenAiModel {
  id: string;
  created: number; // unix seconds
}

/** One GET, so a plain fetch — the openai SDK is not a dependency. */
export async function listOpenAiModels(apiKey: string): Promise<OpenAiModel[]> {
  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`openai models fetch failed: ${res.status}`);
  const body = (await res.json()) as { data: { id: string; created: number }[] };
  // ft:* are the project's own fine-tunes, not OpenAI releases.
  return body.data
    .filter((m) => !m.id.startsWith("ft:"))
    .map((m) => ({ id: m.id, created: m.created }));
}

export function isDatedSnapshot(id: string): boolean {
  return /-\d{4}-\d{2}-\d{2}$/.test(id);
}

// Recent items only: the feed carries its whole history, and an announcement
// for a model appearing now is days old, not years (gpt-6-sol surfaced 19 days
// after the GPT-6 launch post). By date, not count: the newsroom's rate swings
// between one and six posts a day.
const ANNOUNCEMENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * The feed plus the front-page articles it does not carry, newest first as the
 * feed is. The feed skips some launches outright — GPT-6 Astra on 2026-09-03,
 * GPT-6.1 Sol on 2026-09-29 — and those reach the blog channel through Hacker
 * News, so the model watch has to look there too or it posts the id bare
 * beside the article. `stories` are articleCandidates, urls already canonical.
 */
export function withHnArticles(items: NewsItem[], stories: HnStory[], origin: string): NewsItem[] {
  const inFeed = new Set(items.map((i) => canonicalArticleUrl(i.link, origin)));
  const extra: NewsItem[] = stories
    .filter((s) => !inFeed.has(s.url))
    .map((s) => ({
      title: s.title,
      link: s.url,
      description: "",
      guid: s.url,
      published: s.createdAt,
      category: "",
    }));
  return [...items, ...extra].sort((a, b) => (b.published ?? 0) - (a.published ?? 0));
}

/** Recent items as candidates for the announcement of a new id, oldest first. */
export function announcementCandidates(items: NewsItem[], now = Date.now()): Candidate[] {
  return items
    .filter((i) => i.published !== null && now - i.published <= ANNOUNCEMENT_WINDOW_MS)
    .reverse()
    .map((i) => ({
      url: i.link,
      title: i.title,
      detail: [new Date(i.published!).toISOString().slice(0, 10), i.description].filter(Boolean).join(" · "),
    }));
}

export interface OpenAiArticle {
  item: NewsItem;
  bullets: string[];
}

export function formatNewOpenAiModelsPost(
  models: OpenAiModel[],
  articles: OpenAiArticle[] = [],
): string {
  const lines = models.map((m) => {
    const date = m.created ? ` (${new Date(m.created * 1000).toISOString().slice(0, 10)})` : "";
    return `• <code>${escapeHtml(m.id)}</code>${date}`;
  });
  const sections = [`<b>New models in the OpenAI API</b>\n\n${lines.join("\n")}`];
  for (const { item, bullets } of articles) {
    const head = `<b><a href="${item.link}">${escapeHtml(item.title)}</a></b>`;
    sections.push(
      bullets.length === 0 ? head : `${head}\n${bullets.map((b) => `• ${formatInline(b)}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
