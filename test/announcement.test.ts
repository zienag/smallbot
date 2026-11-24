import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAnnouncement, shortlistAnnouncements } from "../src/announcement";

describe("shortlistAnnouncements", () => {
  it("returns the numbered page for each id and drops a zero, a number off the list and an id nobody asked about", async () => {
    mocks.structuredFromPrompt.mockResolvedValue({
      picks: [
        { id: "gpt-6.2-astra", index: 2 },
        { id: "gpt-6.2-sol", index: 0 },
        { id: "aurora-red-alpha", index: 9 },
        { id: "gpt-7", index: 1 },
      ],
    });
    const picks = await shortlistAnnouncements("k", KV, "OpenAI", MODELS, CANDIDATES);
    expect([...picks]).toEqual([["gpt-6.2-astra", CANDIDATES[1]]]);
    const [, , prompt, , family] = mocks.structuredFromPrompt.mock.calls[0];
    expect(prompt).toContain("- gpt-6.2-astra\n- gpt-6.2-sol\n- aurora-red-alpha");
    expect(prompt).toContain("2. Introducing GPT-6.2 Astra and Sol\n   https://openai.com/index/gpt-6-2\n   2026-11-17");
    expect(family).toBe("haiku");
  });

  it("does not ask when there is nothing to choose from", async () => {
    expect((await shortlistAnnouncements("k", KV, "OpenAI", MODELS, [])).size).toBe(0);
    expect(mocks.structuredFromPrompt).not.toHaveBeenCalled();
  });
});

describe("confirmAnnouncement", () => {
  it("keeps only ids that were asked about, in their order", async () => {
    mocks.structuredFromPrompt.mockResolvedValue({ announced: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.2-terra"] });
    expect(
      await confirmAnnouncement("k", KV, "OpenAI", MODELS, { title: "Introducing GPT-6.2 Astra and Sol", text: "body" }),
    ).toEqual(["gpt-6.2-astra", "gpt-6.2-sol"]);
  });
});

const mocks = vi.hoisted(() => ({ structuredFromPrompt: vi.fn() }));
vi.mock("../src/summarize", () => ({ structuredFromPrompt: mocks.structuredFromPrompt }));
afterEach(() => mocks.structuredFromPrompt.mockReset());

const KV = {} as KVNamespace;
const MODELS = [{ id: "gpt-6.2-astra" }, { id: "gpt-6.2-sol" }, { id: "aurora-red-alpha" }];
const CANDIDATES = [
  { url: "https://openai.com/index/cyber", title: "GPT-6 Cyber", detail: "2026-11-10" },
  { url: "https://openai.com/index/gpt-6-2", title: "Introducing GPT-6.2 Astra and Sol", detail: "2026-11-17" },
];
