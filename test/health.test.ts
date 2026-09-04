import { describe, expect, it } from "vitest";
import { type HealthState, loadAllHealth, recordOutcome } from "../src/health";

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
