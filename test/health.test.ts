import { describe, expect, it } from "vitest";
import {
  type HealthState,
  WARNING_TTL_MS,
  collectingWarnings,
  loadAllHealth,
  mergeWarnings,
  recordOutcome,
  warn,
} from "../src/health";

describe("recordOutcome", () => {
  it("counts a run of failures from its first tick and forgets it on success", () => {
    const state: HealthState = {};
    recordOutcome(state, "codex", "boom 1", 1000);
    recordOutcome(state, "codex", "boom 2", 2000);
    expect(state).toEqual({ codex: { failures: 2, error: "boom 2", since: 1000 } });

    recordOutcome(state, "codex", null, 3000);
    expect(state).toEqual({});
  });

  it("keeps sources apart", () => {
    const state: HealthState = {};
    recordOutcome(state, "codex", "boom", 1000);
    recordOutcome(state, "openai_blog", "other", 1000);
    recordOutcome(state, "codex", null, 2000);
    expect(Object.keys(state)).toEqual(["openai_blog"]);
  });
});

describe("loadAllHealth", () => {
  it("merges every cron's score", async () => {
    const store = new Map([
      ["source_health:anthropic", JSON.stringify({ youtube_claude: { failures: 4, error: "404", since: 1 } })],
      ["source_health:status", JSON.stringify({ status: { failures: 1, error: "500", since: 2 } })],
      ["openai_blog_seen", "[]"],
    ]);
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      }),
    } as unknown as KVNamespace;

    expect(await loadAllHealth(kv)).toEqual({
      youtube_claude: { failures: 4, error: "404", since: 1 },
      status: { failures: 1, error: "500", since: 2 },
    });
  });
});

describe("warnings", () => {
  it("attributes a warning to the source that was running, though two runs interleave", async () => {
    const order: string[] = [];
    const blog: string[] = [];
    const status: string[] = [];
    const gate = deferred();

    const first = collectingWarnings(blog, async () => {
      order.push("blog starts");
      await gate.promise;
      warn("pin failed");
      order.push("blog warns");
    });
    const second = collectingWarnings(status, async () => {
      order.push("status starts");
      warn("unpin failed");
      order.push("status warns");
      gate.resolve();
    });
    await Promise.all([first, second]);

    expect(order).toEqual(["blog starts", "status starts", "status warns", "blog warns"]);
    expect(blog).toEqual(["pin failed"]);
    expect(status).toEqual(["unpin failed"]);
  });

  it("is a log line only outside a source's run", () => {
    expect(() => warn("status webhook failed")).not.toThrow();
  });

  it("counts a repeat, keeps sources apart, and drops what a day has not repeated", () => {
    const hour = 60 * 60 * 1000;
    let kept = mergeWarnings([], "blog", ["pin failed"], 0);
    kept = mergeWarnings(kept, "youtube_claude", ["pin failed", "archive lookup failed"], hour);
    kept = mergeWarnings(kept, "blog", ["pin failed"], 2 * hour);
    expect(kept).toEqual([
      { source: "youtube_claude", message: "pin failed", count: 1, since: hour, at: hour },
      { source: "youtube_claude", message: "archive lookup failed", count: 1, since: hour, at: hour },
      { source: "blog", message: "pin failed", count: 2, since: 0, at: 2 * hour },
    ]);

    const nextDay = mergeWarnings(kept, "models", ["press release lookup failed"], hour + WARNING_TTL_MS + 1);
    expect(nextDay.map((w) => w.source)).toEqual(["blog", "models"]);
  });

  it("keeps the newest twenty", () => {
    let kept = mergeWarnings([], "blog", [], 0);
    for (let i = 0; i < 25; i++) kept = mergeWarnings(kept, "blog", [`failure ${i}`], i);
    expect(kept).toHaveLength(20);
    expect(kept[0].message).toBe("failure 5");
    expect(kept[19].message).toBe("failure 24");
  });
});

// --- scaffolding ---

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
