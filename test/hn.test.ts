import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HN_MIN_POINTS,
  HN_WINDOW_MS,
  articleCandidates,
  canonicalArticleUrl,
  fetchHnStories,
  hnSearchUrl,
} from "../src/hn";

describe("hnSearchUrl", () => {
  it("asks for stories on the domain above the bar, submitted inside the window", () => {
    const url = new URL(hnSearchUrl("openai.com", NOW));
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("query")).toBe("openai.com");
    expect(url.searchParams.get("numericFilters")).toBe(
      `points>=${HN_MIN_POINTS},created_at_i>=${Math.floor((NOW - HN_WINDOW_MS) / 1000)}`,
    );
  });
});

describe("fetchHnStories", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the stories that link somewhere and drops the Ask HN threads", async () => {
    vi.stubGlobal("fetch", async () => Response.json(ALGOLIA_RESPONSE));
    expect(await fetchHnStories("openai.com", NOW)).toEqual([
      { title: "GPT-6 Astra", url: "https://openai.com/index/gpt-6-astra/", points: 897, createdAt: 1788460865000 },
      { title: "Path to Astra", url: "https://openai.com/index/path-to-astra/", points: 175, createdAt: 1788294041000 },
    ]);
  });

  it("throws on a refused request so the tick reports the source as failed", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    await expect(fetchHnStories("openai.com", NOW)).rejects.toThrow("hn search failed: 429");
  });
});

describe("canonicalArticleUrl", () => {
  it("matches the form the feed and the seen-set use", () => {
    expect(canonicalArticleUrl("https://openai.com/index/gpt-6-astra/", ORIGIN)).toBe(ASTRA);
    expect(canonicalArticleUrl("http://openai.com/index/gpt-6-astra?utm=hn#top", ORIGIN)).toBe(ASTRA);
    expect(canonicalArticleUrl("https://openai.com/ru-RU/index/gpt-6-astra/", ORIGIN)).toBe(ASTRA);
  });
});

describe("articleCandidates", () => {
  it("keeps one entry per article page at its best score, oldest submission first", () => {
    const stories = [
      story("GPT-6 Astra", "https://openai.com/index/gpt-6-astra/", 897, 200),
      story("GPT 6 Astra", "https://openai.com/gpt-6-astra/", 16, 190),
      story("Astra (mirror)", "https://openai.com/ru-RU/index/gpt-6-astra", 40, 210),
      story("Path to Astra", "https://openai.com/index/path-to-astra/", 175, 100),
      story("Privacy policy", "https://openai.com/policies/eu-privacy-policy/", 50, 150),
    ];
    expect(articleCandidates(stories, ORIGIN, "/index/")).toEqual([
      { title: "Path to Astra", url: "https://openai.com/index/path-to-astra", points: 175, createdAt: 100 },
      { title: "GPT-6 Astra", url: ASTRA, points: 897, createdAt: 200 },
    ]);
  });
});

const NOW = Date.parse("2026-09-03T21:00:00Z");
const ORIGIN = "https://openai.com";
const ASTRA = "https://openai.com/index/gpt-6-astra";

function story(title: string, url: string, points: number, createdAt: number) {
  return { title, url, points, createdAt };
}

// Two real hits from 2026-09-03 and the Ask HN thread that sat between them.
const ALGOLIA_RESPONSE = {
  hits: [
    { title: "GPT-6 Astra", url: "https://openai.com/index/gpt-6-astra/", points: 897, created_at_i: 1788460865 },
    { title: "Ask HN: Why were OpenAI, Claude, and Grok simultaneously down?", url: null, points: 286, created_at_i: 1788448021 },
    { title: "Path to Astra", url: "https://openai.com/index/path-to-astra/", points: 175, created_at_i: 1788294041 },
  ],
};
