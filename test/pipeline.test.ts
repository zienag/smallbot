import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident } from "../src/status";
import { STATUS_INCIDENTS_KEY, type StatusState } from "../src/status";
import type { Env } from "../src/index";
import { runPipeline, runStatusTick } from "../src/index";

describe("release feed", () => {
  it("posts candidates oldest-first and advances the cursor after each post", async () => {
    const kv = fakeKv({ last_posted_version: "1.0.0" });
    const result = await runPipeline(feedEnv(kv));

    expect(result).toBe("claude: posted 1.0.1, 1.0.2");
    expect(mocks.sendMessage.mock.calls.map((c) => c[2])).toEqual([
      expect.stringContaining("1.0.1"),
      expect.stringContaining("1.0.2"),
    ]);
    expect(kv.store.get("last_posted_version")).toBe("1.0.2");
  });

  it("does not post past the npm dist-tag", async () => {
    mocks.fetchNpmLatest.mockResolvedValue("1.0.1");
    const kv = fakeKv({ last_posted_version: "1.0.0" });
    const result = await runPipeline(feedEnv(kv));

    expect(result).toBe("claude: posted 1.0.1");
    expect(kv.store.get("last_posted_version")).toBe("1.0.1");
  });

  it("on a send failure keeps the cursor at the last success and stops the loop", async () => {
    mocks.sendMessage
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("telegram sendMessage failed: 400"));
    const kv = fakeKv({ last_posted_version: "1.0.0" });
    const result = await runPipeline(feedEnv(kv));

    expect(result).toContain("claude: failed");
    expect(kv.store.get("last_posted_version")).toBe("1.0.1");
  });

  it("on first run posts only the newest published version", async () => {
    const kv = fakeKv();
    const result = await runPipeline(feedEnv(kv));

    expect(result).toBe("claude: posted 1.0.2");
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(kv.store.get("last_posted_version")).toBe("1.0.2");
  });
});

describe("tiered blog posts", () => {
  it("posts minor silently, pins major, and marks seen after each post", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue([
      { url: "https://a.com/news/major-launch", source: "Anthropic news" },
      { url: "https://a.com/news/minor-note", source: "Anthropic news" },
      { url: "https://a.com/news/old", source: "Anthropic news" },
    ]);
    mocks.digestBlogPost.mockImplementation(async (_key, _kv, entry: { url: string }) => ({
      title: entry.url,
      tier: entry.url.includes("major") ? "major" : "minor",
      bullets: ["a fact"],
    }));
    const kv = fakeKv({ anthropic_blog_seen: JSON.stringify(["https://a.com/news/old"]) });
    const env = { ...feedEnv(kv), TELEGRAM_CHAT_ID: undefined, TELEGRAM_ANTHROPIC_BLOG_CHAT_ID: "@blogs" };

    const result = await runPipeline(env as unknown as Env);

    expect(result).toContain("blog: posted");
    // Oldest unseen first: minor (silent, no pin), then major (loud, pinned).
    expect(mocks.sendMessage.mock.calls.map((c) => [c[1], c[3]])).toEqual([
      ["@blogs", { silent: true }],
      ["@blogs", { silent: false }],
    ]);
    expect(mocks.pinMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.store.get("anthropic_blog_seen")!)).toEqual([
      "https://a.com/news/old",
      "https://a.com/news/minor-note",
      "https://a.com/news/major-launch",
    ]);
  });
});

describe("status cards", () => {
  it("opens a high-impact card loud, pins it, and records the posted updates", async () => {
    const incident = makeIncident({ impact: "major" });
    mocks.fetchIncidents.mockResolvedValue([incident]);
    mocks.sendMessage.mockResolvedValue(777);
    const state: StatusState = { [incident.id]: { messageId: 0, postedUpdates: [] } };
    const kv = fakeKv({ [STATUS_INCIDENTS_KEY]: JSON.stringify(state) });

    const result = await runStatusTick(statusEnv(kv));

    expect(result).toContain("status: updated");
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "status-token",
      "@status",
      expect.stringContaining("API errors"),
      expect.objectContaining({ silent: false }),
    );
    expect(mocks.pinMessage).toHaveBeenCalledWith("status-token", "@status", 777);
    const written = JSON.parse(kv.store.get(STATUS_INCIDENTS_KEY)!) as StatusState;
    expect(written[incident.id]).toEqual({ messageId: 777, postedUpdates: ["u1"] });
  });

  it("edits the existing card in place and unpins on resolve", async () => {
    const incident = makeIncident({
      resolved: true,
      updates: [
        { id: "u1", status: "investigating", body: "b", createdAt: "2026-08-01T00:00:00Z" },
        { id: "u2", status: "resolved", body: "done", createdAt: "2026-08-01T01:00:00Z" },
      ],
    });
    mocks.fetchIncidents.mockResolvedValue([incident]);
    const state: StatusState = { [incident.id]: { messageId: 42, postedUpdates: ["u1"] } };
    const kv = fakeKv({ [STATUS_INCIDENTS_KEY]: JSON.stringify(state) });

    await runStatusTick(statusEnv(kv));

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.editMessageText).toHaveBeenCalledWith(
      "status-token",
      "@status",
      42,
      expect.stringContaining("API errors"),
      expect.anything(),
    );
    expect(mocks.unpinMessage).toHaveBeenCalledWith("status-token", "@status", 42);
    const written = JSON.parse(kv.store.get(STATUS_INCIDENTS_KEY)!) as StatusState;
    expect(written[incident.id]).toEqual({ messageId: 42, postedUpdates: ["u1", "u2"] });
  });
});

// --- scaffolding ---

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  sendAlbum: vi.fn(),
  fetchChangelog: vi.fn(),
  fetchNpmLatest: vi.fn(),
  summarize: vi.fn(),
  fetchIncidents: vi.fn(),
  fetchAllBlogEntries: vi.fn(),
  digestBlogPost: vi.fn(),
}));

vi.mock("../src/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram")>()),
  sendMessage: mocks.sendMessage,
  editMessageText: mocks.editMessageText,
  pinMessage: mocks.pinMessage,
  unpinMessage: mocks.unpinMessage,
  sendAlbum: mocks.sendAlbum,
}));
vi.mock("../src/changelog", () => ({ fetchChangelog: mocks.fetchChangelog }));
vi.mock("../src/npm", () => ({ fetchNpmLatest: mocks.fetchNpmLatest }));
vi.mock("../src/summarize", () => ({ summarize: mocks.summarize }));
vi.mock("../src/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/status")>()),
  fetchIncidents: mocks.fetchIncidents,
}));
vi.mock("../src/blogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/blogs")>()),
  fetchAllBlogEntries: mocks.fetchAllBlogEntries,
  digestBlogPost: mocks.digestBlogPost,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendMessage.mockResolvedValue(101);
  mocks.fetchChangelog.mockResolvedValue([
    { version: "1.0.2", notes: "- two" },
    { version: "1.0.1", notes: "- one" },
    { version: "1.0.0", notes: "- zero" },
  ]);
  mocks.fetchNpmLatest.mockResolvedValue("1.0.2");
  mocks.summarize.mockImplementation(async (_key, _kv, _product, version) => ({
    bullets: [`summary of ${version}`],
  }));
});

interface FakeKv {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

function fakeKv(init: Record<string, string> = {}): FakeKv {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function feedEnv(kv: FakeKv): Env {
  return {
    RELEASES: kv,
    TELEGRAM_BOT_TOKEN: "bot-token",
    ANTHROPIC_API_KEY: "api-key",
    TRIGGER_SECRET: "secret",
    TELEGRAM_CHAT_ID: "@claude",
    DRY_RUN: "0",
  } as unknown as Env;
}

function statusEnv(kv: FakeKv): Env {
  return {
    RELEASES: kv,
    TELEGRAM_BOT_TOKEN: "bot-token",
    ANTHROPIC_API_KEY: "api-key",
    TRIGGER_SECRET: "secret",
    TELEGRAM_CHAT_ID: "@claude",
    TELEGRAM_STATUS_CHAT_ID: "@status",
    TELEGRAM_STATUS_BOT_TOKEN: "status-token",
    DRY_RUN: "0",
  } as unknown as Env;
}

function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "inc1",
    name: "API errors",
    impact: "minor",
    resolved: false,
    url: "https://stspg.io/x",
    startedAt: "2026-08-01T00:00:00Z",
    components: ["Claude API"],
    updates: [{ id: "u1", status: "investigating", body: "b", createdAt: "2026-08-01T00:00:00Z" }],
    ...overrides,
  };
}
