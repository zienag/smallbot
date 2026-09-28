import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PICK_PROMPT,
  findAnnouncement,
  formatNewOpenAiModelsPost,
  isDatedSnapshot,
  listOpenAiModels,
  pickAnnouncement,
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
    expect(findAnnouncement("gpt-5.9", [item("Introducing GPT-5.9", 50 * DAY)])).toBeNull();
    expect(findAnnouncement("gpt-5.9", [item("Introducing GPT-5.9", 40 * DAY)])?.title).toBe(
      "Introducing GPT-5.9",
    );
    expect(findAnnouncement("gpt-5.9", [{ ...item("Introducing GPT-5.9"), published: null }])).toBeNull();
  });

  it("falls back to a sibling's launch when nothing names the model or its family plainly", () => {
    expect(findAnnouncement("gpt-6-sol", GPT6_FEED)?.title).toBe(
      "GPT-6 Astra: A new generation of intelligence",
    );
    expect(findAnnouncement("gpt-6-luna", GPT6_FEED)?.title).toBe(
      "GPT-6 Astra: A new generation of intelligence",
    );
  });

  it("reads the non-breaking hyphen the newsroom writes as the id's hyphen", () => {
    expect(findAnnouncement("gpt-5.9", [item("Introducing GPT‑5.9")])?.title).toBe(
      "Introducing GPT‑5.9",
    );
  });
});

describe("pickAnnouncement", () => {
  afterEach(() => mocks.structuredFromPrompt.mockReset());

  it("hands the model the recent candidates, oldest first, and returns the one it numbers", async () => {
    mocks.structuredFromPrompt.mockResolvedValue({ index: 2 });
    const feed = [item("Introducing ChatGPT Images 2.5", 1 * DAY), item("Unrelated", 2 * DAY)];
    expect((await pickAnnouncement("k", KV, "gpt-image-2.5-flare", feed))?.title).toBe(
      "Introducing ChatGPT Images 2.5",
    );
    const [, , prompt, , family] = mocks.structuredFromPrompt.mock.calls[0];
    expect(family).toBe("sonnet");
    expect(prompt).toBe(PICK_PROMPT("gpt-image-2.5-flare", [feed[1], feed[0]]));
    expect(prompt).toContain("1. Unrelated");
    expect(prompt).toContain("2. Introducing ChatGPT Images 2.5");
  });

  it("returns nothing on 0 or a number outside the list", async () => {
    mocks.structuredFromPrompt.mockResolvedValueOnce({ index: 0 }).mockResolvedValueOnce({ index: 3 });
    expect(await pickAnnouncement("k", KV, "gpt-live-1", [item("A"), item("B")])).toBeNull();
    expect(await pickAnnouncement("k", KV, "gpt-live-1", [item("A"), item("B")])).toBeNull();
  });

  it("does not ask for a dated snapshot or when the window is empty", async () => {
    expect(await pickAnnouncement("k", KV, "gpt-5.5-2026-04-23", [item("Introducing GPT-5.5")])).toBeNull();
    expect(await pickAnnouncement("k", KV, "gpt-5.9", [item("Introducing GPT-5.9", 50 * DAY)])).toBeNull();
    expect(mocks.structuredFromPrompt).not.toHaveBeenCalled();
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

const mocks = vi.hoisted(() => ({ structuredFromPrompt: vi.fn() }));
vi.mock("../src/summarize", () => ({ structuredFromPrompt: mocks.structuredFromPrompt }));
const KV = {} as KVNamespace;

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

// The feed on 2026-09-22, when gpt-6-sol and gpt-6-luna appeared in the API:
// GPT-6 launched as "GPT-6 Astra" nineteen days earlier and no post names
// GPT-6 without the codename.
const GPT6_FEED = [
  item("Higgsfield AI ships new video features in a day with GPT-6 Astra", 1 * DAY),
  item("Hex turns complex analysis into visual reports with GPT‑6 Astra", 6 * DAY),
  item("Perplexity trusts GPT-6 Astra with end-to-end systems", 8 * DAY),
  item("GPT-6 Astra: The next generation in intelligence for work", 13 * DAY),
  item("How GPT-5.6 Sol helps run quantum computing experiments", 14 * DAY),
  item("GPT-6 Astra: A new generation of intelligence", 19 * DAY),
  item("Safety overview: GPT-6 Astra", 19 * DAY),
];
