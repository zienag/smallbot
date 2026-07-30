import type { NewsItem } from "./openai_news";
import { escapeHtml, formatInline } from "./telegram";

export const OPENAI_KNOWN_MODELS_KEY = "openai_known_models";
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

// A launch names the model at the head of its title ("Introducing GPT-5.5",
// "GPT-5.6: Frontier intelligence that scales with your ambition", "Previewing
// GPT-5.6 Sol"). Everything else mentions it further in ("How GPT-5.6 fuses
// frontier intelligence with frontier efficiency" is a retrospective on a model
// out for three weeks), which is why the model name has to lead.
const TITLE_LEAD = /^(?:introducing|previewing|meet)\s+(?:the\s+)?/i;
// Newest items only: the feed carries its whole history, and an announcement
// for a model appearing now is days old, not years. ~1.3 items/day, so a month.
const ANNOUNCEMENT_WINDOW = 40;

function namePattern(segments: string[]): RegExp {
  const body = segments.map((s) => s.replace(/\./g, "\\.")).join("[\\s-]?");
  // Two boundaries: the first keeps gpt-5 off "GPT-5.5 System Card", the second
  // keeps gpt-5.6 off "Previewing GPT-5.6 Sol" — a capitalized word carrying on
  // from the name means the title is naming a longer model than the one asked
  // about, and that model's own launch is the post we want.
  return new RegExp(`^${body}(?![\\w.])(?![-\\s][A-Z])`, "i");
}

/**
 * The article that announced this model, or null. Tries the full id first, then
 * shorter prefixes: a family launch post names the family ("GPT-5.6: ...")
 * while its variants — sol, terra, luna — exist only as ids.
 */
export function findAnnouncement(id: string, items: NewsItem[]): NewsItem | null {
  if (isDatedSnapshot(id)) return null;
  const segments = id.split("-");
  // Oldest first: the launch precedes the follow-ups that reuse the name.
  const window = items
    .slice(0, ANNOUNCEMENT_WINDOW)
    .filter((i) => !/system card/i.test(i.title))
    .reverse();
  for (let n = segments.length; n >= 2; n--) {
    const re = namePattern(segments.slice(0, n));
    const hit = window.find((i) => re.test(i.title.replace(TITLE_LEAD, "")));
    if (hit) return hit;
  }
  return null;
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
