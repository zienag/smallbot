/**
 * Which article announced a model. Decided in two steps by a small model: a
 * generous shortlist from titles, then a strict reading of the article's own
 * text. Titles alone cannot tell a family launch that introduces its variants
 * from a sibling's launch that never mentions them, and every rule written to
 * guess it from the id attached the wrong article sooner or later: GPT-6.1
 * Sol's launch to gpt-6.1-terra (2026-10-26), the GPT-6 Cyber post to
 * gpt-6-astra-healthcare (2026-11-24).
 */

import { structuredFromPrompt } from "./summarize";

const FAMILY = "haiku";
const ARTICLE_TEXT_LIMIT = 12000;

/**
 * The API lists a model minutes before its article is published (gpt-6.2-astra
 * by sixteen, 2026-11-17), so a post that went out without one keeps looking
 * for this long and is edited when the article turns up.
 */
export const FOLLOWUP_WINDOW_MS = 3 * 60 * 60 * 1000;

export interface ModelRef {
  id: string;
  name?: string; // display name, when the API gives one
}

export interface Candidate {
  url: string;
  title: string; // "" when only the address is known (a sitemap entry)
  detail?: string;
}

const modelLines = (models: ModelRef[]) =>
  models.map((m) => `- ${m.id}${m.name && m.name !== m.id ? ` (${m.name})` : ""}`).join("\n");

export const SHORTLIST_PROMPT = (company: string, models: ModelRef[], candidates: Candidate[]) => `\
A Telegram channel announces every model id that appears in the ${company} API \
and attaches the article that announced the model, when there is one. These ids \
just appeared:
${modelLines(models)}

Below are pages ${company} has published or links to, numbered.

${candidates
  .map((c, i) => `${i + 1}. ${c.title || "(no title)"}\n   ${c.url}${c.detail ? `\n   ${c.detail}` : ""}`)
  .join("\n")}

For each id, which page could be the article announcing that model? The \
article's text is read before anything is attached, so name a page whenever it \
plausibly is the one, and 0 when none is. Publishers do not spell a name the \
way the API does: "ChatGPT Images 2.5" is gpt-image-2.5, an address ending in \
claude-fable-and-mythos-5-2 is Claude Fable 5.2. One launch article often \
covers several ids, and a family's launch may introduce variants that never \
get a page of their own. A customer story, a system card, a safety or policy \
post and a follow-up about a model already out are not announcements. An \
article that clearly belongs to another version or another model is not a \
candidate when the model's own article is in the list.`;

const SHORTLIST_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, index: { type: "integer" } },
        required: ["id", "index"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

/** The page each id might have been announced on; an id with none is absent. */
export async function shortlistAnnouncements(
  apiKey: string,
  kv: KVNamespace,
  company: string,
  models: ModelRef[],
  candidates: Candidate[],
): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  if (models.length === 0 || candidates.length === 0) return out;
  const { picks } = await structuredFromPrompt<{ picks: { id: string; index: number }[] }>(
    apiKey,
    kv,
    SHORTLIST_PROMPT(company, models, candidates),
    SHORTLIST_SCHEMA,
    FAMILY,
  );
  for (const { id, index } of picks) {
    const candidate = Number.isInteger(index) ? candidates[index - 1] : undefined;
    if (candidate && models.some((m) => m.id === id)) out.set(id, candidate);
  }
  return out;
}

export const CONFIRM_PROMPT = (company: string, models: ModelRef[], title: string, text: string) => `\
A Telegram channel announces every model id that appears in the ${company} API \
and attaches the article that announced the model. These ids just appeared:
${modelLines(models)}

It is about to attach the article below. Readers take the attached article as \
the announcement of the ids listed above it, so an article about anything else \
misleads them; an id listed with no article is fine.

Article title: ${title}

Article text (extracted from the page, may contain navigation noise):
${text}

Which of these ids does this article announce? It announces a model when it \
presents that very model as new: it names it, spelled the publisher's way, and \
says it is being released or previewed. It does not announce a model it never \
mentions, a different version of it, or a specialised variant (a healthcare, \
cyber or regional edition) it says nothing about. A model brought up only for \
comparison is not announced either. Return the ids it announces, which may be \
none.`;

const CONFIRM_SCHEMA = {
  type: "object",
  properties: { announced: { type: "array", items: { type: "string" } } },
  required: ["announced"],
  additionalProperties: false,
};

/** The ids, among those asked about, that the article itself announces. */
export async function confirmAnnouncement(
  apiKey: string,
  kv: KVNamespace,
  company: string,
  models: ModelRef[],
  article: { title: string; text: string },
): Promise<string[]> {
  if (models.length === 0) return [];
  const { announced } = await structuredFromPrompt<{ announced: string[] }>(
    apiKey,
    kv,
    CONFIRM_PROMPT(company, models, article.title, article.text.slice(0, ARTICLE_TEXT_LIMIT)),
    CONFIRM_SCHEMA,
    FAMILY,
  );
  return models.map((m) => m.id).filter((id) => announced.includes(id));
}

/** A post that went out with ids no article was found for, still being looked after. */
export interface Followup<M extends { id: string }, A> {
  messageId: number;
  postedAt: number; // epoch ms
  models: M[];
  articles: A[];
  matched: string[]; // ids an attached article announces
  asked: string[]; // candidate urls that already got a verdict
}

export async function loadFollowups<F extends { postedAt: number }>(
  kv: KVNamespace,
  key: string,
): Promise<F[]> {
  const raw = await kv.get(key);
  return raw ? (JSON.parse(raw) as F[]) : [];
}

export async function saveFollowups<F>(kv: KVNamespace, key: string, followups: F[]): Promise<void> {
  if (followups.length === 0) await kv.delete(key);
  else await kv.put(key, JSON.stringify(followups));
}

export function isOpen(followup: { postedAt: number }, now: number): boolean {
  return now - followup.postedAt <= FOLLOWUP_WINDOW_MS;
}
