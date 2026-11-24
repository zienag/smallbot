import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announcementCandidates,
  formatNewOpenAiModelsPost,
  isDatedSnapshot,
  listOpenAiModels,
  withHnArticles,
} from "../src/openai_models";

describe("announcementCandidates", () => {
  it("offers the recent items, oldest first, and leaves the feed's history out", () => {
    const feed = [item("Newest", DAY), item("Launch", 40 * DAY), item("History", 50 * DAY), { ...item("Undated"), published: null }];
    expect(announcementCandidates(feed).map((c) => c.title)).toEqual(["Launch", "Newest"]);
    expect(announcementCandidates(feed)[1]).toEqual({
      url: "https://openai.com/index/newest",
      title: "Newest",
      detail: `${new Date(Date.now() - DAY).toISOString().slice(0, 10)} · One sentence from the feed.`,
    });
  });
});

describe("withHnArticles", () => {
  // The Algolia hits of 2026-09-29, after articleCandidates; the feed's newest
  // item was a day old and carried neither launch.
  const sol = { title: "GPT 6.1 Sol", url: "https://openai.com/index/introducing-gpt-6-1-sol", points: 287, createdAt: Date.now() - DAY / 24 };
  const dots = { title: "Dots", url: "https://openai.com/index/introducing-dots", points: 188, createdAt: Date.now() - DAY / 24 };
  const old = { title: "OpenAI (2015)", url: "https://openai.com/index/introducing-openai", points: 44, createdAt: Date.now() - 2 * DAY };
  const feed = [
    item("Unrelated", DAY),
    { ...item("Introducing OpenAI", 3650 * DAY), link: "https://openai.com/index/introducing-openai/" },
  ];

  it("adds only what the feed does not carry, newest first like the feed", () => {
    const merged = withHnArticles(feed, [old, sol, dots], "https://openai.com");
    expect(merged.map((i) => i.title)).toEqual(["GPT 6.1 Sol", "Dots", "Unrelated", "Introducing OpenAI"]);
  });
});

describe("formatNewOpenAiModelsPost", () => {
  it("lists ids with the date they appeared in the API", () => {
    expect(formatNewOpenAiModelsPost([{ id: "gpt-5.7", created: 1784937600 }])).toBe(
      "<b>New models in the OpenAI API</b>\n\n• <code>gpt-5.7</code> (2026-07-25)",
    );
  });

  it("appends the announcement as its own linked section", () => {
    const post = formatNewOpenAiModelsPost([{ id: "gpt-5.7", created: 0 }], [
      { item: item("Introducing GPT-5.7"), bullets: ["Ships `gpt-5.7-codex` too", "2x cheaper"] },
    ]);
    expect(post).toBe(
      "<b>New models in the OpenAI API</b>\n\n• <code>gpt-5.7</code>\n\n" +
        '<b><a href="https://openai.com/index/introducing-gpt-5.7">Introducing GPT-5.7</a></b>\n' +
        "• Ships <code>gpt-5.7-codex</code> too\n• 2x cheaper",
    );
  });

  it("keeps the link when the article could not be digested", () => {
    const post = formatNewOpenAiModelsPost([{ id: "gpt-5.7", created: 0 }], [
      { item: item("Introducing GPT-5.7"), bullets: [] },
    ]);
    expect(post.endsWith('<b><a href="https://openai.com/index/introducing-gpt-5.7">Introducing GPT-5.7</a></b>')).toBe(true);
  });
});

describe("listOpenAiModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops the project's own fine-tunes", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: [
          { id: "gpt-5.7", created: 1 },
          { id: "ft:gpt-5.4-mini:acme::abc123", created: 2 },
        ],
      }),
    );
    expect(await listOpenAiModels("sk-test")).toEqual([{ id: "gpt-5.7", created: 1 }]);
  });

  it("throws on a failed fetch rather than reporting an empty list", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));
    await expect(listOpenAiModels("sk-test")).rejects.toThrow("401");
  });
});

describe("isDatedSnapshot", () => {
  it("recognizes OpenAI's dated ids", () => {
    expect(isDatedSnapshot("gpt-5.5-2026-04-23")).toBe(true);
    expect(isDatedSnapshot("gpt-5.5-pro")).toBe(false);
    expect(isDatedSnapshot("gpt-4-0613")).toBe(false);
  });
});

const DAY = 24 * 60 * 60 * 1000;

function item(title: string, age = DAY) {
  const link = `https://openai.com/index/${title.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
  return {
    title,
    link,
    description: "One sentence from the feed.",
    guid: link,
    published: Date.now() - age,
    category: "Product",
  };
}
