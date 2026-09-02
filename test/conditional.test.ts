import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGELOG_URL, fetchChangelog } from "../src/changelog";
import { VALIDATORS_KEY, Validators, conditionalFetch } from "../src/conditional";

describe("Validators", () => {
  it("sends the committed validators as conditional headers, nothing for an unknown url", async () => {
    const kv = fakeKv({
      [VALIDATORS_KEY]: JSON.stringify({
        "https://a/x": { etag: '"e1"', lastModified: "Mon, 01 Sep 2026 00:00:00 GMT" },
      }),
    });
    const v = await Validators.load(kv);

    expect(v.headers("https://a/x")).toEqual({
      "If-None-Match": '"e1"',
      "If-Modified-Since": "Mon, 01 Sep 2026 00:00:00 GMT",
    });
    expect(v.headers("https://a/y")).toEqual({});
  });

  it("a 200 stages its validator; only a commit makes save write it", async () => {
    const kv = fakeKv();
    const v = Validators.empty();
    stubFetch(200, "one", { etag: '"e1"' });

    const res = await conditionalFetch("https://a/x", v);
    expect(await res!.text()).toBe("one");
    await v.save(kv);
    expect(kv.store.has(VALIDATORS_KEY)).toBe(false);

    v.commit("https://a/x");
    await v.save(kv);
    expect(JSON.parse(kv.store.get(VALIDATORS_KEY)!)).toEqual({ "https://a/x": { etag: '"e1"' } });
  });

  it("asks with the committed validator and treats a 304 as null", async () => {
    const kv = fakeKv({ [VALIDATORS_KEY]: JSON.stringify({ "https://a/x": { etag: '"e1"' } }) });
    const v = await Validators.load(kv);
    const fetch = stubFetch(304);

    expect(await conditionalFetch("https://a/x", v, { "User-Agent": "ua" })).toBeNull();
    expect(fetch.mock.calls[0][1]).toEqual({ headers: { "User-Agent": "ua", "If-None-Match": '"e1"' } });
  });

  it("without validators it is a plain GET", async () => {
    const fetch = stubFetch(200, "body");

    const res = await conditionalFetch("https://a/x", undefined);
    expect(await res!.text()).toBe("body");
    expect(fetch.mock.calls[0][1]).toEqual({ headers: {} });
  });

  it("a 200 without validators stages nothing, so commit and save are no-ops", async () => {
    const kv = fakeKv();
    const v = Validators.empty();
    stubFetch(200, "body");

    await conditionalFetch("https://a/x", v);
    v.commit("https://a/x");
    await v.save(kv);
    expect(kv.store.has(VALIDATORS_KEY)).toBe(false);
  });
});

describe("fetchChangelog", () => {
  it("is null on a 304 and the parsed releases on a 200", async () => {
    stubFetch(304);
    expect(await fetchChangelog(Validators.empty())).toBeNull();

    const fetch = stubFetch(200, "## 1.0.1\n- a\n\n## 1.0.0\n- b\n", { etag: '"c1"' });
    const v = Validators.empty();
    expect(await fetchChangelog(v)).toEqual([
      { version: "1.0.1", notes: "- a" },
      { version: "1.0.0", notes: "- b" },
    ]);
    expect(fetch.mock.calls[0][0]).toBe(CHANGELOG_URL);
    v.commit(CHANGELOG_URL);
    expect(v.headers(CHANGELOG_URL)).toEqual({ "If-None-Match": '"c1"' });
  });
});

// --- scaffolding ---

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: string | null = null, headers: Record<string, string> = {}) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(status === 304 ? null : body, { status, headers }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

interface FakeKv {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

function fakeKv(init: Record<string, string> = {}): FakeKv & KVNamespace {
  const store = new Map(Object.entries(init));
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as FakeKv & KVNamespace;
}
