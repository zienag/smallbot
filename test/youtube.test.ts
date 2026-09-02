import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  companionArticle,
  companionLine,
  formatRoundupPost,
  formatVideoPost,
  groupVideos,
  isRecentVideo,
  isSettled,
  normalizeUrl,
  parseVideoFeed,
} from "../src/youtube";

describe("isSettled", () => {
  const now = Date.now();
  const at = (ageMs: number) => ({ videoId: "x", title: "t", url: "u", published: now - ageMs, description: "" });

  it("holds a batch whose newest video is under five minutes old", () => {
    expect(isSettled([at(20 * 60_000), at(2 * 60_000)], now)).toBe(false);
    expect(isSettled([at(20 * 60_000), at(6 * 60_000)], now)).toBe(true);
    expect(isSettled([], now)).toBe(true);
  });
});

describe("companionArticle", () => {
  const posted = new Map([
    ["https://www.anthropic.com/claude-fable-and-mythos-5-1", "https://www.anthropic.com/claude-fable-and-mythos-5-1"],
    ["https://www.anthropic.com/news/enterprise-frontier-safeguards", "https://www.anthropic.com/news/enterprise-frontier-safeguards"],
  ]);
  const video = (description: string) => ({ videoId: "v", title: "T", url: "u", published: 0, description });

  it("finds the posted article a description links to, modulo slashes and query strings", () => {
    expect(companionArticle(video("Learn more: https://www.anthropic.com/claude-fable-and-mythos-5-1/?utm=yt"), posted)).toBe(
      "https://www.anthropic.com/claude-fable-and-mythos-5-1",
    );
    expect(companionArticle(video("Read the post https://www.anthropic.com/news/enterprise-frontier-safeguards."), posted)).toBe(
      "https://www.anthropic.com/news/enterprise-frontier-safeguards",
    );
  });

  it("is null for links the channel never posted, or no links", () => {
    expect(companionArticle(video("https://www.anthropic.com/claude/fable"), posted)).toBeNull();
    expect(companionArticle(video("no links here"), posted)).toBeNull();
  });

  it("normalizes scheme, trailing slashes and query strings only", () => {
    expect(normalizeUrl("http://a.com/x/?q=1#h")).toBe("https://a.com/x");
    expect(normalizeUrl("https://a.com/x")).toBe("https://a.com/x");
  });
});

describe("roundup and companion formats", () => {
  const videos = [
    { videoId: "d1", title: "Demo <one>", url: "https://www.youtube.com/watch?v=d1", published: 0, description: "" },
    { videoId: "d2", title: "Demo two", url: "https://www.youtube.com/watch?v=d2", published: 0, description: "" },
  ];

  it("a roundup leads with the topic and counts the videos, then lists them as links", () => {
    expect(formatRoundupPost("Fable 5.1 launch demos", "Claude YouTube", videos)).toBe(
      "<b>Fable 5.1 launch demos</b> · 2 videos on Claude YouTube\n\n" +
        '• <a href="https://www.youtube.com/watch?v=d1">Demo &lt;one&gt;</a>\n' +
        '• <a href="https://www.youtube.com/watch?v=d2">Demo two</a>',
    );
  });

  it("a companion line is a play mark and the linked title", () => {
    expect(companionLine(videos[0])).toBe('▶ <a href="https://www.youtube.com/watch?v=d1">Demo &lt;one&gt;</a>');
  });
});

describe("groupVideos", () => {
  const kv = {} as KVNamespace;
  const v = (id: string) => ({ videoId: id, title: `Title ${id}`, url: `u${id}`, published: 0, description: "d" });

  it("keeps the model's groups, drops invented ids, and gives forgotten videos a group of their own", async () => {
    structured.mockResolvedValue({
      groups: [
        { title: "Launch demos", tier: "minor", videoIds: ["a", "b", "ghost"] },
        { title: "Dup", tier: "normal", videoIds: ["a"] },
      ],
    });
    const groups = await groupVideos("key", kv, "Claude YouTube", [v("a"), v("b"), v("c")]);
    expect(groups.map((g) => [g.title, g.tier, g.videos.map((x) => x.videoId)])).toEqual([
      ["Launch demos", "minor", ["a", "b"]],
      ["Title c", "normal", ["c"]],
    ]);
  });

  it("puts every video, its title and description in the prompt", async () => {
    structured.mockResolvedValue({ groups: [] });
    await groupVideos("key", kv, "OpenAI YouTube", [v("a"), v("b")]);
    const prompt = structured.mock.calls.at(-1)?.[2] as string;
    expect(prompt).toContain("a | Title a | d");
    expect(prompt).toContain("b | Title b | d");
    expect(prompt).toContain("in English");
  });
});

const structured = vi.hoisted(() => vi.fn());
vi.mock("../src/summarize", () => ({ structuredFromPrompt: structured }));

describe("parseVideoFeed", () => {
  const videos = parseVideoFeed(fixture);

  it("takes every entry, newest first, with the watch url", () => {
    expect(videos).toHaveLength(15);
    expect(videos[0].videoId).toBe("RyjROxHLi_g");
    expect(videos[0].url).toBe("https://www.youtube.com/watch?v=RyjROxHLi_g");
    expect(videos[0].published).toBe(Date.parse("2026-08-08T14:00:10+00:00"));
  });

  it("carries the full media description", () => {
    const video = videos.find((v) => v.videoId === "b8SV4U6fEIc")!;
    expect(video.title).toBe("How auto mode works with Claude Code");
    expect(video.description).toContain("Auto mode lets Claude Code");
    expect(video.description).toContain("0:00 Intro");
  });
});

describe("isRecentVideo", () => {
  const video = parseVideoFeed(fixture)[0];

  it("passes a fresh video and rejects the same one a fortnight on", () => {
    expect(isRecentVideo(video, video.published! + 1000)).toBe(true);
    expect(isRecentVideo(video, video.published! + 15 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("counts an undated video as stale", () => {
    expect(isRecentVideo({ ...video, published: null }, Date.now())).toBe(false);
  });
});

describe("formatVideoPost", () => {
  const video = {
    videoId: "abc",
    title: "Codex <3 plugins",
    url: "https://www.youtube.com/watch?v=abc",
    published: 0,
    description: "",
  };

  it("leads with the bare title — no source label — and inline-formats bullets", () => {
    expect(formatVideoPost(video, ["Run `claude` to start"])).toBe(
      '<b><a href="https://www.youtube.com/watch?v=abc">Codex &lt;3 plugins</a></b>' +
        "\n\n• Run <code>claude</code> to start",
    );
  });

  it("degrades to header only without bullets", () => {
    expect(formatVideoPost(video, [])).toBe(
      '<b><a href="https://www.youtube.com/watch?v=abc">Codex &lt;3 plugins</a></b>',
    );
  });
});

const fixture = readFileSync("test/fixtures-youtube.atom", "utf8");
