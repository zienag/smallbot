import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Incident } from "../src/status";
import { STATUS_INCIDENTS_KEY, type StatusState } from "../src/status";
import type { Env } from "../src/index";
import { CHANGELOG_URL } from "../src/changelog";
import { VALIDATORS_KEY, Validators } from "../src/conditional";
import { ANTHROPIC_CRON, OPENAI_CRON } from "../src/crons";
import worker, { runPipeline, runStatusTick } from "../src/index";
import { YOUTUBE_CHANNELS, uploadsUrl } from "../src/youtube";

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

  it("keeps posting and advancing the cursor when the archive is broken", async () => {
    const kv = fakeKv({ last_posted_version: "1.0.0" });
    const env = feedEnv(kv);
    (env as { ARCHIVE: unknown }).ARCHIVE = { prepare: () => { throw new Error("boom"); } };
    const result = await runPipeline(env);

    expect(result).toBe("claude: posted 1.0.1, 1.0.2");
    expect(kv.store.get("last_posted_version")).toBe("1.0.2");
  });

  it("preview delivers the force-post to the owner's DM and leaves the cursor alone", async () => {
    const kv = fakeKv({ last_posted_version: "1.0.0" });
    const env = { ...feedEnv(kv), TELEGRAM_OWNER_CHAT_ID: "4242" };

    const result = await runPipeline(env as unknown as Env, { forceVersion: "1.0.1", preview: true });

    expect(result).toBe("previewed claude 1.0.1");
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0][1]).toBe("4242");
    expect(kv.store.get("last_posted_version")).toBe("1.0.0");
  });

  it("on first run posts only the newest published version", async () => {
    const kv = fakeKv();
    const result = await runPipeline(feedEnv(kv));

    expect(result).toBe("claude: posted 1.0.2");
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(kv.store.get("last_posted_version")).toBe("1.0.2");
  });

  it("asks npm only when the feed has something newer than the cursor", async () => {
    const kv = fakeKv({ last_posted_version: "1.0.2" });
    const result = await runPipeline(feedEnv(kv));

    expect(result).toBe("claude: nothing to post (last=1.0.2)");
    expect(mocks.fetchNpmLatest).not.toHaveBeenCalled();
  });
});

describe("conditional feeds", () => {
  it("reports a feed that answered 304 as unchanged", async () => {
    mocks.fetchChangelog.mockResolvedValue(null);
    const kv = fakeKv({ last_posted_version: "1.0.2" });

    expect(await runPipeline(feedEnv(kv))).toBe("claude: unchanged");
  });

  it("a first run reads the feed unconditionally", async () => {
    const kv = fakeKv();
    await runPipeline(feedEnv(kv));

    expect(mocks.fetchChangelog).toHaveBeenCalledWith(undefined);
  });

  it("commits the feed's validator only once everything newer is posted", async () => {
    mocks.fetchChangelog.mockImplementation(async (validators?: Validators) => {
      validators?.stage(CHANGELOG_URL, new Response("", { headers: { etag: '"v1"' } }));
      return [
        { version: "1.0.2", notes: "- two" },
        { version: "1.0.1", notes: "- one" },
      ];
    });
    const kv = fakeKv({ last_posted_version: "1.0.0" });

    // The npm gate holds 1.0.2 back: the feed must be re-read next tick.
    mocks.fetchNpmLatest.mockResolvedValue("1.0.1");
    expect(await runPipeline(feedEnv(kv))).toBe("claude: posted 1.0.1");
    expect(kv.store.has(VALIDATORS_KEY)).toBe(false);

    mocks.fetchNpmLatest.mockResolvedValue("1.0.2");
    expect(await runPipeline(feedEnv(kv))).toBe("claude: posted 1.0.2");
    expect(JSON.parse(kv.store.get(VALIDATORS_KEY)!)).toEqual({ [CHANGELOG_URL]: { etag: '"v1"' } });

    // Nothing newer: a full read with nothing to do commits as well.
    kv.store.delete(VALIDATORS_KEY);
    expect(await runPipeline(feedEnv(kv))).toBe("claude: nothing to post (last=1.0.2)");
    expect(kv.store.has(VALIDATORS_KEY)).toBe(true);
  });

  it("a dry run never commits a validator", async () => {
    mocks.fetchChangelog.mockImplementation(async (validators?: Validators) => {
      validators?.stage(CHANGELOG_URL, new Response("", { headers: { etag: '"v1"' } }));
      return [{ version: "1.0.2", notes: "- two" }];
    });
    const kv = fakeKv({ last_posted_version: "1.0.2" });

    await runPipeline(feedEnv(kv), { dryOverride: true });
    expect(kv.store.has(VALIDATORS_KEY)).toBe(false);
  });

  it("absorbs an old dated card into the seen-set without posting it", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    mocks.fetchAllBlogEntries.mockResolvedValue([
      { url: "https://www.anthropic.com/claude-fable-and-mythos-5-1", source: "Anthropic News", published: now - day },
      { url: "https://www.anthropic.com/features/making-of-claude-code", source: "Anthropic News", published: now - 58 * day },
    ]);
    mocks.digestBlogPost.mockResolvedValue({ title: "Fable 5.1", tier: "major", bullets: ["a fact"] });
    const kv = fakeKv({ anthropic_blog_seen: "[]", "youtube_seen:claude": "[]", "youtube_seen:anthropic": "[]" });
    const env = { ...feedEnv(kv), TELEGRAM_CHAT_ID: undefined, TELEGRAM_ANTHROPIC_BLOG_CHAT_ID: "@blogs" };

    const result = await runPipeline(env as unknown as Env);

    expect(result).toContain("blog: posted https://www.anthropic.com/claude-fable-and-mythos-5-1 [major], skipped 1 stale");
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.store.get("anthropic_blog_seen")!)).toEqual([
      "https://www.anthropic.com/features/making-of-claude-code",
      "https://www.anthropic.com/claude-fable-and-mythos-5-1",
    ]);
  });

  it("reports unchanged blog indexes without touching the seen-set", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue(null);
    const kv = fakeKv({ anthropic_blog_seen: JSON.stringify(["https://a.com/news/old"]) });
    const env = { ...feedEnv(kv), TELEGRAM_CHAT_ID: undefined, TELEGRAM_ANTHROPIC_BLOG_CHAT_ID: "@blogs" };

    expect((await runPipeline(env as unknown as Env)).split("\n")[0]).toBe("blog: unchanged");
    expect(mocks.fetchAllBlogEntries.mock.calls[0][0]).toBeInstanceOf(Validators);
    expect(kv.store.get("anthropic_blog_seen")).toBe(JSON.stringify(["https://a.com/news/old"]));
  });
});

describe("openai news list verdicts", () => {
  const now = Date.now();
  const item = {
    title: "A customer story",
    link: "https://openai.com/index/customer-story",
    description: "d",
    guid: "https://openai.com/index/customer-story",
    published: now - 60_000,
    category: "",
  };
  const env = (kv: FakeKv) =>
    ({ ...feedEnv(kv), TELEGRAM_CHAT_ID: undefined, TELEGRAM_OPENAI_BLOG_CHAT_ID: "@oai" }) as unknown as Env;

  it("asks the news list about an unlisted item once, then holds the verdict for hours", async () => {
    mocks.fetchOpenAiNews.mockResolvedValue([item]);
    mocks.fetchNewsListSlugs.mockResolvedValue({ slugs: new Set(["index/something-else"]), via: "fetch" });
    const kv = fakeKv({ openai_blog_seen: "[]", openai_dev_blog_seen: "[]", "youtube_seen:openai": "[]" });

    const first = await runPipeline(env(kv), { group: "openai" });
    expect(first).toContain("openai_blog: nothing new, 1 not in the news list (via=fetch)");
    expect(mocks.fetchNewsListSlugs).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(kv.store.get("openai_unlisted")!))).toEqual([item.guid]);

    const second = await runPipeline(env(kv), { group: "openai" });
    expect(second).toContain("openai_blog: nothing new, 1 unlisted (verdict held)");
    expect(mocks.fetchNewsListSlugs).toHaveBeenCalledTimes(1);

    kv.store.set("openai_unlisted", JSON.stringify({ [item.guid]: now - 7 * 60 * 60 * 1000 }));
    await runPipeline(env(kv), { group: "openai" });
    expect(mocks.fetchNewsListSlugs).toHaveBeenCalledTimes(2);
  });

  it("does not hold a verdict when the list was unreachable", async () => {
    mocks.fetchOpenAiNews.mockResolvedValue([item]);
    mocks.fetchNewsListSlugs.mockResolvedValue({ slugs: null, via: "fetch:403 browser:failed" });
    const kv = fakeKv({ openai_blog_seen: "[]", openai_dev_blog_seen: "[]", "youtube_seen:openai": "[]" });

    await runPipeline(env(kv), { group: "openai" });
    await runPipeline(env(kv), { group: "openai" });
    expect(mocks.fetchNewsListSlugs).toHaveBeenCalledTimes(2);
    expect(kv.store.has("openai_unlisted")).toBe(false);
  });
});

describe("openai hn watch", () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const astra = "https://openai.com/index/gpt-6-astra";
  const story = { title: "GPT-6 Astra", url: `${astra}/`, points: 890, createdAt: now - hour };
  const env = (kv: FakeKv) =>
    ({
      ...feedEnv(kv),
      TELEGRAM_CHAT_ID: undefined,
      TELEGRAM_OPENAI_BLOG_CHAT_ID: "@oai",
      TELEGRAM_OWNER_CHAT_ID: "4242",
    }) as unknown as Env;
  const seeded = () => fakeKv({ openai_blog_seen: "[]", openai_dev_blog_seen: "[]", "youtube_seen:openai": "[]" });

  it("posts a front-page article the feed never listed, under the page's own title", async () => {
    mocks.fetchHnStories.mockResolvedValue([story]);
    mocks.fetchPageMarkdown.mockResolvedValue("# GPT-6 Astra: A new generation of intelligence | OpenAI\n\nWe're introducing");
    mocks.digestArticle.mockResolvedValue({ tier: "major", bullets: ["saturates ARC-AGI-3"], minutes: 28 });
    const kv = seeded();

    const result = await runPipeline(env(kv), { group: "openai" });

    expect(result).toContain("openai_hn: posted GPT-6 Astra: A new generation of intelligence [major, browser, 890 points]");
    expect(mocks.digestArticle.mock.calls[0][3]).toBe("GPT-6 Astra: A new generation of intelligence");
    expect(mocks.sendMessage.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [
        "@oai",
        `<b><a href="${astra}">GPT-6 Astra: A new generation of intelligence</a></b>\n\n• saturates ARC-AGI-3\n\n<i>OpenAI · 28 min read</i>`,
      ],
    ]);
    expect(mocks.pinMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.store.get("openai_blog_seen")!)).toEqual([astra]);
  });

  it("leaves a page the feed carries to the blog watch, whatever its verdict", async () => {
    mocks.fetchHnStories.mockResolvedValue([story]);
    mocks.fetchOpenAiNews.mockResolvedValue([
      { title: "GPT-6 Astra", link: `${astra}/`, description: "d", guid: astra, published: now - hour, category: "" },
    ]);
    mocks.fetchNewsListSlugs.mockResolvedValue({ slugs: new Set(["index/other"]), via: "fetch" });
    const kv = seeded();

    const result = await runPipeline(env(kv), { group: "openai" });

    expect(result).toContain("openai_hn: nothing new, 1 in the feed");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("skips what the channel already posted", async () => {
    mocks.fetchHnStories.mockResolvedValue([story]);
    const kv = fakeKv({ openai_blog_seen: JSON.stringify([astra]), openai_dev_blog_seen: "[]", "youtube_seen:openai": "[]" });

    expect(await runPipeline(env(kv), { group: "openai" })).toContain("openai_hn: nothing new (1 on HN)");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("has nothing to compare against until the blog watch has seeded", async () => {
    mocks.fetchHnStories.mockResolvedValue([story]);
    const kv = fakeKv({ openai_dev_blog_seen: "[]", "youtube_seen:openai": "[]" });

    // A dry run seeds nothing, so the seen-set is still missing when the HN watch runs.
    const result = await runPipeline(env(kv), { group: "openai", dryOverride: true });

    expect(result).toContain("openai_blog: would seed 0 seen (dry)");
    expect(result).toContain("openai_hn: waiting for the blog watch to seed");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

describe("source health", () => {
  const env = (kv: FakeKv) =>
    ({
      ...feedEnv(kv),
      TELEGRAM_CHAT_ID: undefined,
      TELEGRAM_CODEX_CHAT_ID: "@codex",
      TELEGRAM_OWNER_CHAT_ID: "4242",
    }) as unknown as Env;

  it("scores a run of failures, serves it at /health, and clears it on recovery", async () => {
    mocks.fetchCodexReleases.mockRejectedValue(new Error("atom fetch failed: 503"));
    const kv = fakeKv({ codex_last_posted_version: "0.1.0" });

    for (let tick = 1; tick <= 4; tick++) {
      expect(await runPipeline(env(kv), { group: "openai" })).toBe("codex: failed: Error: atom fetch failed: 503");
    }
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    const score = JSON.parse(kv.store.get("source_health:openai")!);
    expect(score.codex).toMatchObject({ failures: 4, error: "Error: atom fetch failed: 503" });

    const health = await worker.fetch(new Request("https://w/health"), env(kv));
    expect(await health.json()).toMatchObject({ ok: false, failing: { codex: { failures: 4 } } });

    mocks.fetchCodexReleases.mockResolvedValue([]);
    await runPipeline(env(kv), { group: "openai" });
    expect(kv.store.has("source_health:openai")).toBe(false);
    const clear = await worker.fetch(new Request("https://w/health"), env(kv));
    expect(await clear.json()).toMatchObject({ ok: true, failing: {} });
  });

  it("keeps no score on a dry run", async () => {
    mocks.fetchCodexReleases.mockRejectedValue(new Error("boom"));
    const kv = fakeKv({ codex_last_posted_version: "0.1.0" });

    for (let tick = 1; tick <= 5; tick++) await runPipeline(env(kv), { group: "openai", dryOverride: true });
    expect(kv.store.has("source_health:openai")).toBe(false);
  });

  it("scores the status tick under its own key", async () => {
    mocks.fetchIncidents.mockRejectedValue(new Error("statuspage 500"));
    const kv = fakeKv();

    for (let tick = 1; tick <= 4; tick++) expect(await runStatusTick(statusEnv(kv))).toBe("status: failed: Error: statuspage 500");
    expect(JSON.parse(kv.store.get("source_health:status")!).status.failures).toBe(4);
  });
});

describe("cron dispatch", () => {
  it("runs one company's sources per cron and leaves an unowned cron alone", async () => {
    const kv = fakeKv({ last_posted_version: "1.0.2", codex_last_posted_version: "0.1.0" });
    const env = { ...feedEnv(kv), TELEGRAM_CODEX_CHAT_ID: "@codex" } as unknown as Env;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const tick = (cron: string) =>
      worker.scheduled({ cron } as Parameters<typeof worker.scheduled>[0], env, {} as never);

    await tick(OPENAI_CRON);
    expect(log.mock.calls.at(-1)?.[0]).toBe("codex: posted 0.1.1");
    expect(mocks.fetchChangelog).not.toHaveBeenCalled();

    await tick(ANTHROPIC_CRON);
    expect(log.mock.calls.at(-1)?.[0]).toBe("claude: nothing to post (last=1.0.2)");
    expect(mocks.fetchCodexReleases).toHaveBeenCalledTimes(1);

    await tick("1 2 3 4 5");
    expect(log.mock.calls.at(-1)?.[0]).toContain("unknown cron");
    expect(mocks.fetchChangelog).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("the /run hook without a group runs every company", async () => {
    const kv = fakeKv({ last_posted_version: "1.0.0", codex_last_posted_version: "0.1.0" });
    const env = { ...feedEnv(kv), TELEGRAM_CODEX_CHAT_ID: "@codex" } as unknown as Env;

    const result = await runPipeline(env);

    expect(result).toBe("claude: posted 1.0.1, 1.0.2\ncodex: posted 0.1.1");
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

describe("youtube videos", () => {
  it("posts a new video, drops the Short, absorbs the stale one, marks all seen", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    mocks.fetchAllBlogEntries.mockResolvedValue([]);
    const claude = YOUTUBE_CHANNELS.find((c) => c.key === "claude")!;
    mocks.fetchChannelUploads.mockImplementation(async (_key: string, channelId: string) =>
      channelId === claude.channelId
        ? [
            { videoId: "vid1", title: "How auto mode works", url: "https://www.youtube.com/watch?v=vid1", published: now - day, description: "d" },
            { videoId: "short1", title: "Promo cut", url: "https://www.youtube.com/watch?v=short1", published: now - 2 * day, description: "" },
            { videoId: "old1", title: "Ancient", url: "https://www.youtube.com/watch?v=old1", published: now - 30 * day, description: "" },
          ]
        : [],
    );
    mocks.isShort.mockImplementation(async (id: string) => id === "short1");
    const kv = fakeKv({
      "youtube_seen:claude": JSON.stringify(["seen1"]),
      "youtube_seen:anthropic": JSON.stringify([]),
    });
    const env = { ...feedEnv(kv), TELEGRAM_CHAT_ID: undefined, TELEGRAM_ANTHROPIC_BLOG_CHAT_ID: "@blogs" };

    const result = await runPipeline(env as unknown as Env);

    expect(result).toContain("youtube_claude: posted How auto mode works [normal], skipped 1 stale, 1 shorts");
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0][1]).toBe("@blogs");
    expect(mocks.sendMessage.mock.calls[0][2]).toContain("How auto mode works");
    // The video card is the point: YouTube posts are the only ones with a preview.
    expect(mocks.sendMessage.mock.calls[0][3]).toEqual({ silent: false, linkPreview: true });
    expect(JSON.parse(kv.store.get("youtube_seen:claude")!)).toEqual([
      "seen1",
      "old1",
      "short1",
      "vid1",
    ]);
  });
});

describe("youtube batches", () => {
  const now = Date.now();
  const minute = 60 * 1000;
  const claude = YOUTUBE_CHANNELS.find((c) => c.key === "claude")!;
  const video = (id: string, title: string, ageMs: number, description = "") => ({
    videoId: id,
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    published: now - ageMs,
    description,
  });
  const blogEnv = (kv: FakeKv) =>
    ({ ...feedEnv(kv), TELEGRAM_CHAT_ID: undefined, TELEGRAM_ANTHROPIC_BLOG_CHAT_ID: "@blogs" }) as unknown as Env;
  const feedOf = (videos: unknown[]) =>
    mocks.fetchChannelUploads.mockImplementation(async (_key: string, channelId: string) =>
      channelId === claude.channelId ? videos : [],
    );

  it("reads a first run in full, takes a 304 as unchanged, commits only once nothing is left to post", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue(null);
    const url = uploadsUrl(claude.channelId);
    const uploads = (videos: unknown[]) =>
      mocks.fetchChannelUploads.mockImplementation(async (_key: string, channelId: string, validators?: Validators) => {
        if (channelId !== claude.channelId) return [];
        validators?.stage(url, new Response("", { headers: { etag: '"u1"' } }));
        return videos;
      });
    const kv = fakeKv({ "youtube_seen:anthropic": "[]", anthropic_blog_seen: "[]" });

    uploads([]);
    expect(await runPipeline(blogEnv(kv))).toContain("youtube_claude: seeded 0 seen");
    expect(mocks.fetchChannelUploads.mock.calls.filter((c) => c[1] === claude.channelId).at(-1)?.[2]).toBeUndefined();

    mocks.fetchChannelUploads.mockResolvedValue(null);
    expect(await runPipeline(blogEnv(kv))).toContain("youtube_claude: unchanged");
    expect(mocks.fetchChannelUploads.mock.calls.filter((c) => c[1] === claude.channelId).at(-1)?.[2]).toBeInstanceOf(Validators);

    // A burst still arriving is judged next tick, so the uploads are re-read.
    uploads([video("v1", "First", 2 * minute)]);
    expect(await runPipeline(blogEnv(kv))).toContain("youtube_claude: 1 new, settling");
    expect(kv.store.has(VALIDATORS_KEY)).toBe(false);

    uploads([video("v1", "First", 10 * minute)]);
    expect(await runPipeline(blogEnv(kv))).toContain("youtube_claude: posted First [normal]");
    expect(JSON.parse(kv.store.get(VALIDATORS_KEY)!)).toEqual({ [url]: { etag: '"u1"' } });
  });

  it("is off without an API key", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue(null);
    const kv = fakeKv({ "youtube_seen:claude": "[]", "youtube_seen:anthropic": "[]", anthropic_blog_seen: "[]" });

    const result = await runPipeline({ ...blogEnv(kv), YOUTUBE_API_KEY: undefined } as Env);

    expect(result).not.toContain("youtube_");
    expect(mocks.fetchChannelUploads).not.toHaveBeenCalled();
  });

  it("waits out a burst that is still arriving", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue(null);
    feedOf([video("v2", "Second", 2 * minute), video("v1", "First", 10 * minute)]);
    const kv = fakeKv({ "youtube_seen:claude": "[]", "youtube_seen:anthropic": "[]", anthropic_blog_seen: "[]" });

    const result = await runPipeline(blogEnv(kv));

    expect(result).toContain("youtube_claude: 2 new, settling");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(kv.store.get("youtube_seen:claude")).toBe("[]");
  });

  it("appends a companion video to its article's post instead of posting it", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue(null);
    const article = "https://www.anthropic.com/claude-fable-and-mythos-5-1";
    feedOf([video("v1", "Introducing Claude Fable 5.1", 10 * minute, `Read more: ${article}/`)]);
    mocks.findPostedMessage.mockResolvedValue({ messageId: 64, text: "<b>Introducing Claude Fable 5.1</b>\n\n• a fact" });
    const kv = fakeKv({
      "youtube_seen:claude": "[]",
      "youtube_seen:anthropic": "[]",
      anthropic_blog_seen: JSON.stringify([article]),
    });

    const result = await runPipeline(blogEnv(kv));

    expect(result).toContain(`youtube_claude: posted Introducing Claude Fable 5.1 → ${article}`);
    expect(mocks.findPostedMessage).toHaveBeenCalledWith(undefined, "@blogs", article);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.editMessageText).toHaveBeenCalledWith(
      "bot-token",
      "@blogs",
      64,
      '<b>Introducing Claude Fable 5.1</b>\n\n• a fact\n\n▶ <a href="https://www.youtube.com/watch?v=v1">Introducing Claude Fable 5.1</a>',
    );
    expect(JSON.parse(kv.store.get("youtube_seen:claude")!)).toEqual(["v1"]);
  });

  it("posts a settled batch as one roundup per topic and a card per lone video", async () => {
    mocks.fetchAllBlogEntries.mockResolvedValue(null);
    const demos = [video("d1", "Demo one", 12 * minute), video("d2", "Demo two", 11 * minute)];
    const lone = video("s1", "How Claude thinks", 10 * minute);
    // The feed is newest first; the batch is handled oldest first.
    feedOf([lone, demos[1], demos[0]]);
    mocks.groupVideos.mockResolvedValue([
      { title: "Fable 5.1 launch demos", tier: "minor", videos: demos },
      { title: lone.title, tier: "normal", videos: [lone] },
    ]);
    const kv = fakeKv({ "youtube_seen:claude": "[]", "youtube_seen:anthropic": "[]", anthropic_blog_seen: "[]" });

    const result = await runPipeline(blogEnv(kv));

    expect(result).toContain(
      "youtube_claude: posted Fable 5.1 launch demos (2 videos) [minor] | How Claude thinks [normal]",
    );
    expect(mocks.groupVideos.mock.calls[0][3].map((v: { videoId: string }) => v.videoId)).toEqual(["d1", "d2", "s1"]);
    expect(mocks.sendMessage.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      [
        '<b>Fable 5.1 launch demos</b> · 2 videos on Claude YouTube\n\n• <a href="https://www.youtube.com/watch?v=d1">Demo one</a>\n• <a href="https://www.youtube.com/watch?v=d2">Demo two</a>',
        { silent: true },
      ],
      [expect.stringContaining("How Claude thinks"), { silent: false, linkPreview: true }],
    ]);
    expect(JSON.parse(kv.store.get("youtube_seen:claude")!)).toEqual(["d1", "d2", "s1"]);
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
  fetchCodexReleases: vi.fn(),
  fetchNpmLatest: vi.fn(),
  summarize: vi.fn(),
  fetchIncidents: vi.fn(),
  fetchAllBlogEntries: vi.fn(),
  digestBlogPost: vi.fn(),
  digestArticle: vi.fn(),
  fetchPageMarkdown: vi.fn(),
  fetchHnStories: vi.fn(),
  fetchOpenAiNews: vi.fn(),
  fetchNewsListSlugs: vi.fn(),
  fetchDevPosts: vi.fn(),
  fetchChannelUploads: vi.fn(),
  isShort: vi.fn(),
  digestVideo: vi.fn(),
  groupVideos: vi.fn(),
  findPostedMessage: vi.fn(),
}));

vi.mock("../src/telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram")>()),
  sendMessage: mocks.sendMessage,
  editMessageText: mocks.editMessageText,
  pinMessage: mocks.pinMessage,
  unpinMessage: mocks.unpinMessage,
  sendAlbum: mocks.sendAlbum,
}));
vi.mock("../src/changelog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/changelog")>()),
  fetchChangelog: mocks.fetchChangelog,
}));
vi.mock("../src/codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/codex")>()),
  fetchCodexReleases: mocks.fetchCodexReleases,
}));
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
  digestArticle: mocks.digestArticle,
}));
vi.mock("../src/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/browser")>()),
  fetchPageMarkdown: mocks.fetchPageMarkdown,
}));
vi.mock("../src/hn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hn")>()),
  fetchHnStories: mocks.fetchHnStories,
}));
vi.mock("../src/openai_news", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/openai_news")>()),
  fetchOpenAiNews: mocks.fetchOpenAiNews,
  fetchNewsListSlugs: mocks.fetchNewsListSlugs,
}));
vi.mock("../src/openai_dev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/openai_dev")>()),
  fetchDevPosts: mocks.fetchDevPosts,
}));
vi.mock("../src/youtube", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/youtube")>()),
  fetchChannelUploads: mocks.fetchChannelUploads,
  isShort: mocks.isShort,
  digestVideo: mocks.digestVideo,
  groupVideos: mocks.groupVideos,
}));
vi.mock("../src/archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/archive")>()),
  findPostedMessage: mocks.findPostedMessage,
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
  mocks.fetchCodexReleases.mockResolvedValue([
    { version: "0.1.1", url: "https://github.com/openai/codex/releases/tag/rust-v0.1.1", notes: "- n" },
  ]);
  mocks.summarize.mockImplementation(async (_key, _kv, _product, version) => ({
    bullets: [`summary of ${version}`],
  }));
  mocks.fetchChannelUploads.mockResolvedValue([]);
  mocks.fetchHnStories.mockResolvedValue([]);
  mocks.fetchPageMarkdown.mockResolvedValue("# A page\n\ntext");
  mocks.digestArticle.mockResolvedValue({ tier: "normal", bullets: ["a fact"], minutes: 3 });
  mocks.fetchOpenAiNews.mockResolvedValue([]);
  mocks.fetchNewsListSlugs.mockResolvedValue({ slugs: new Set<string>(), via: "fetch" });
  mocks.fetchDevPosts.mockResolvedValue([]);
  mocks.isShort.mockResolvedValue(false);
  mocks.digestVideo.mockResolvedValue({ tier: "normal", bullets: ["a fact"] });
  mocks.groupVideos.mockImplementation(async (_key, _kv, _label, videos: { title: string }[]) =>
    videos.map((v) => ({ title: v.title, tier: "normal", videos: [v] })),
  );
  mocks.findPostedMessage.mockResolvedValue(null);
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
    YOUTUBE_API_KEY: "yt-key",
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
