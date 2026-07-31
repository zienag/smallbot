import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findAnnouncement,
  formatNewOpenAiModelsPost,
  isDatedSnapshot,
  listOpenAiModels,
} from "../src/openai_models";

describe("findAnnouncement", () => {
  it("matches the launch that names the exact model", () => {
    expect(findAnnouncement("gpt-5.6-sol", FEED)?.title).toBe(
      "Previewing GPT-5.6 Sol: a next-generation model",
    );
  });

  it("falls back to the family launch for a variant that has no post of its own", () => {
    expect(findAnnouncement("gpt-5.6-luna", FEED)?.title).toBe(
      "GPT-5.6: Frontier intelligence that scales with your ambition",
    );
  });

  it("takes the launch, not a later post reusing the name", () => {
    expect(findAnnouncement("gpt-5.6", FEED)?.title).toBe(
      "GPT-5.6: Frontier intelligence that scales with your ambition",
    );
  });

  it("ignores a post that only mentions the model mid-title", () => {
    const retrospective = FEED.filter((i) => i.title.startsWith("How GPT-5.6"));
    expect(retrospective).toHaveLength(1);
    expect(findAnnouncement("gpt-5.6", retrospective)).toBeNull();
  });

  it("does not let a shorter id match a longer version", () => {
    expect(findAnnouncement("gpt-5", FEED)).toBeNull();
  });

  it("skips system cards", () => {
    expect(findAnnouncement("gpt-5.5", [item("GPT-5.5 System Card")])).toBeNull();
  });

  it("never enriches a dated snapshot", () => {
    expect(findAnnouncement("gpt-5.5-2026-04-23", FEED)).toBeNull();
  });

  it("does not reach past the recency window into the feed's history", () => {
    const old = [...Array(40)].map((_, i) => item(`Unrelated post ${i}`));
    expect(findAnnouncement("gpt-5.9", [...old, item("Introducing GPT-5.9")])).toBeNull();
    expect(findAnnouncement("gpt-5.9", [...old.slice(1), item("Introducing GPT-5.9")])?.title).toBe(
      "Introducing GPT-5.9",
    );
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

function item(title: string) {
  const link = `https://openai.com/index/${title.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
  return {
    title,
    link,
    description: "One sentence from the feed.",
    guid: link,
    published: Date.parse("Fri, 31 Jul 2026 15:00:00 GMT"),
    category: "Product",
  };
}

// Real titles from openai.com/news/rss.xml, newest first as the feed serves them.
const FEED = [
  item("How enabling two settings tripled our scores on the ARC-AGI-3 benchmark"),
  item("How GPT-5.6 fuses frontier intelligence with frontier efficiency"),
  item("GPT-5.6 is now the preferred model in Microsoft 365 Copilot"),
  item("GPT-5.6: Frontier intelligence that scales with your ambition"),
  item("Previewing GPT-5.6 Sol: a next-generation model"),
  item("GPT-5.5 System Card"),
  item("Introducing GPT-5.5"),
];
