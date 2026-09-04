/**
 * Hacker News as the input that does not depend on how a publisher lists its
 * own pages. On 2026-09-03 OpenAI put the GPT-6 Astra launch at
 * openai.com/index/gpt-6-astra and listed it nowhere a feed reader looks — not
 * in news/rss.xml, not in the newsroom's list endpoint, not in a sitemap —
 * while HN had the story at 890 points within the hour. Algolia's HN index is
 * public and unauthenticated, and answers a domain query filtered by points
 * and submission age in one request.
 */
export const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";

/**
 * Front-page territory. Measured over two weeks of openai.com and anthropic.com
 * submissions: four stories cleared it, all four were launches; the customer
 * stories, status pages and policy posts sat under ten.
 */
export const HN_MIN_POINTS = 30;

/** How long after submission a story is still considered. */
export const HN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface HnStory {
  title: string;
  url: string;
  points: number;
  createdAt: number; // epoch ms
}

export function hnSearchUrl(domain: string, now: number): string {
  const since = Math.floor((now - HN_WINDOW_MS) / 1000);
  const params = new URLSearchParams({
    tags: "story",
    query: domain,
    numericFilters: `points>=${HN_MIN_POINTS},created_at_i>=${since}`,
    hitsPerPage: "50",
  });
  return `${HN_SEARCH_URL}?${params}`;
}

interface HnHit {
  title?: string;
  url?: string | null;
  points?: number;
  created_at_i?: number;
}

/** Stories linking the domain, newest first as the API returns them. */
export async function fetchHnStories(domain: string, now: number): Promise<HnStory[]> {
  const res = await fetch(hnSearchUrl(domain, now));
  if (!res.ok) throw new Error(`hn search failed: ${res.status}`);
  const body = (await res.json()) as { hits?: HnHit[] };
  return (body.hits ?? [])
    // An "Ask HN" about the company has no url; the query matches its text.
    .filter((h): h is HnHit & { url: string } => typeof h.url === "string" && h.url !== "")
    .map((h) => ({
      title: h.title ?? "",
      url: h.url,
      points: h.points ?? 0,
      createdAt: (h.created_at_i ?? 0) * 1000,
    }));
}

/**
 * The url in the form the seen-sets and feeds use: https, no query or
 * fragment, no trailing slash, and no locale segment — openai.com serves
 * /ru-RU/index/… to a Russian reader and people submit what they see.
 */
export function canonicalArticleUrl(url: string, origin: string): string {
  return url
    .replace(/^http:/, "https:")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(new RegExp(`^${origin.replace(/\./g, "\\.")}/[a-z]{2}-[A-Z]{2}/`), `${origin}/`);
}

/**
 * The submitted pages under the site's article prefix, one entry per page at
 * its highest score, oldest submission first (the order the watches post in).
 */
export function articleCandidates(stories: HnStory[], origin: string, prefix: string): HnStory[] {
  const byUrl = new Map<string, HnStory>();
  for (const story of stories) {
    const url = canonicalArticleUrl(story.url, origin);
    if (!url.startsWith(origin + prefix)) continue;
    const prior = byUrl.get(url);
    if (!prior || story.points > prior.points) byUrl.set(url, { ...story, url });
  }
  return [...byUrl.values()].sort((a, b) => a.createdAt - b.createdAt);
}
