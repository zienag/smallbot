import { afterEach, describe, expect, it, vi } from "vitest";
import { matchPress } from "../src/models";

describe("matchPress", () => {
  // 2026-09-01: claude-fable-5-1 went out under the Fable 5 launch page.
  it("attaches a page only when its text announces the model, and asks again about one that did not load", async () => {
    mocks.shortlistAnnouncements.mockResolvedValue(
      new Map([
        ["claude-fable-5-1", CANDIDATES[0]],
        ["claude-opus-6", CANDIDATES[1]],
      ]),
    );
    mocks.confirmAnnouncement.mockResolvedValue([]);
    const fetchPage = async (url: string) => (url === CANDIDATES[0].url ? PAGE : null);

    const match = await matchPress("k", KV, MODELS, CANDIDATES, false, fetchPage);

    expect(match).toEqual({ press: [], matched: [], asked: [CANDIDATES[0].url, CANDIDATES[2].url] });
    expect(mocks.summaryFromPrompt).not.toHaveBeenCalled();
  });

  it("digests the confirmed page once for every id it announces", async () => {
    mocks.shortlistAnnouncements.mockResolvedValue(new Map([["claude-fable-5-1", CANDIDATES[0]]]));
    mocks.confirmAnnouncement.mockResolvedValue(["claude-fable-5-1", "claude-opus-6"]);
    mocks.summaryFromPrompt.mockResolvedValue({ bullets: ["a", "b", "c", "d", "e"] });

    const match = await matchPress("k", KV, MODELS, CANDIDATES, false, async () => PAGE);

    expect(match.press).toEqual([{ url: CANDIDATES[0].url, title: "Introducing Claude Fable 5.1", bullets: ["a", "b", "c", "d"], photos: [] }]);
    expect(match.matched).toEqual(["claude-fable-5-1", "claude-opus-6"]);
    expect(mocks.confirmAnnouncement.mock.calls[0][3]).toEqual([
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { id: "claude-opus-6", name: "Claude Opus 6" },
    ]);
  });
});

const mocks = vi.hoisted(() => ({
  shortlistAnnouncements: vi.fn(),
  confirmAnnouncement: vi.fn(),
  summaryFromPrompt: vi.fn(),
}));
vi.mock("../src/announcement", () => ({
  shortlistAnnouncements: mocks.shortlistAnnouncements,
  confirmAnnouncement: mocks.confirmAnnouncement,
}));
vi.mock("../src/summarize", () => ({ summaryFromPrompt: mocks.summaryFromPrompt, structuredFromPrompt: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const KV = {} as KVNamespace;
const MODELS = [
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1", createdAt: "" },
  { id: "claude-opus-6", displayName: "Claude Opus 6", createdAt: "" },
];
const CANDIDATES = [
  { url: "https://www.anthropic.com/news/claude-fable-5-mythos-5", title: "" },
  { url: "https://www.anthropic.com/claude-opus-6", title: "" },
  { url: "https://www.anthropic.com/news/s1-sec", title: "Anthropic files S-1" },
];
const PAGE =
  "<html><head><title>Introducing Claude Fable 5.1 \\ Anthropic</title></head><body><article><p>Body</p></article></body></html>";
