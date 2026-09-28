import type { NewsItem } from "./openai_news";
import { structuredFromPrompt } from "./summarize";
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
// Recent items only: the feed carries its whole history, and an announcement
// for a model appearing now is days old, not years (gpt-6-sol surfaced 19 days
// after the GPT-6 launch post). By date, not count: the newsroom's rate swings
// between one and six posts a day.
const ANNOUNCEMENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
// Titles write the model with a non-breaking hyphen about a third of the time
// ("GPT‑5.6 Sol", "GPT‑Live‑1"); the id is plain ASCII.
const HYPHENS = /[‐-–]/g;

function namePattern(segments: string[], strict: boolean): RegExp {
  const body = segments.map((s) => s.replace(/\./g, "\\.")).join("[\\s-]?");
  // Two boundaries: the first keeps gpt-5 off "GPT-5.5 System Card", the second
  // keeps gpt-5.6 off "Previewing GPT-5.6 Sol" — a capitalized word carrying on
  // from the name means the title is naming a longer model than the one asked
  // about, and that model's own launch is the post we want.
  return new RegExp(`^${body}(?![\\w.])${strict ? "(?![-\\s][A-Z])" : ""}`, "i");
}

/**
 * The article that announced this model, or null. Tries the full id first, then
 * shorter prefixes: a family launch post names the family ("GPT-5.6: ...")
 * while its variants — sol, terra, luna — exist only as ids. When no title names
 * the model or its family plainly, a sibling's launch is the closest thing: GPT-6
 * launched as "GPT-6 Astra" with no plain GPT-6 post, so that is where gpt-6-sol
 * and gpt-6-luna were announced.
 */
export function findAnnouncement(id: string, items: NewsItem[], now = Date.now()): NewsItem | null {
  if (isDatedSnapshot(id)) return null;
  const segments = id.split("-");
  const window = announcementCandidates(items, now).map((i) => ({
    item: i,
    name: i.title.replace(HYPHENS, "-").replace(TITLE_LEAD, ""),
  }));
  for (const strict of [true, false]) {
    for (let n = segments.length; n >= 2; n--) {
      const re = namePattern(segments.slice(0, n), strict);
      const hit = window.find((w) => re.test(w.name));
      if (hit) return hit.item;
    }
  }
  return null;
}

/** Recent items, system cards dropped, oldest first: the launch precedes the follow-ups that reuse the name. */
export function announcementCandidates(items: NewsItem[], now = Date.now()): NewsItem[] {
  return items
    .filter((i) => i.published !== null && now - i.published <= ANNOUNCEMENT_WINDOW_MS)
    .filter((i) => !/system card/i.test(i.title))
    .reverse();
}

export const PICK_PROMPT = (id: string, candidates: NewsItem[]) => `\
A Telegram channel announces every model id that appears in the OpenAI API, and \
attaches the newsroom post that announced it when there is one. A new id just \
appeared: ${id}. Below are the newsroom's posts from the last weeks, numbered, \
oldest first.

${candidates
  .map((c, i) => {
    const date = c.published === null ? "" : ` (${new Date(c.published).toISOString().slice(0, 10)})`;
    return `${i + 1}. ${c.title}${date}\n   ${c.description}`;
  })
  .join("\n")}

Which post is the announcement of this model? The newsroom does not spell the \
name the way the API does: "ChatGPT Images 2.5" is gpt-image-2.5, a family \
launch such as "GPT-6 Astra" also announces its later variants gpt-6-sol and \
gpt-6-luna, and a launch may put the model mid-title. What is not the \
announcement: a customer story, a follow-up about a model already out, a \
safety overview, a post about a different model that merely shares a prefix. \
Answer with the post's number, or 0 when no post here announces it — a bare \
id in the channel is fine, a wrong article is not.`;

const PICK_SCHEMA = {
  type: "object",
  properties: { index: { type: "integer" } },
  required: ["index"],
  additionalProperties: false,
};

/**
 * The announcement as a model sees it, for ids findAnnouncement cannot read:
 * a name the newsroom spells its own way, a model named mid-title. It can only
 * pick from the same candidates, never invent one, and it runs on sonnet.
 */
export async function pickAnnouncement(
  apiKey: string,
  kv: KVNamespace,
  id: string,
  items: NewsItem[],
  now = Date.now(),
): Promise<NewsItem | null> {
  if (isDatedSnapshot(id)) return null;
  const candidates = announcementCandidates(items, now);
  if (candidates.length === 0) return null;
  const { index } = await structuredFromPrompt<{ index: number }>(
    apiKey,
    kv,
    PICK_PROMPT(id, candidates),
    PICK_SCHEMA,
    "sonnet",
  );
  return Number.isInteger(index) && index >= 1 && index <= candidates.length
    ? candidates[index - 1]
    : null;
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
