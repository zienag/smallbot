import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatVideoPost, isRecentVideo, parseVideoFeed } from "../src/youtube";

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
