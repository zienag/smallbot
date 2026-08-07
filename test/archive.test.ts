import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAction, readActions, readPhoto } from "../src/archive";
import type { Env } from "../src/index";
import worker from "../src/index";

describe("recordAction / readActions", () => {
  it("round-trips an action and drops null fields", async () => {
    const db = fakeD1();
    await recordAction(db, {
      chat: "@blogs",
      kind: "send",
      messageId: 7,
      text: "<b>hi</b>",
      silent: true,
      tier: "minor",
    });
    await recordAction(db, { chat: "@blogs", kind: "pin", messageId: 7 });

    const { cursor, actions } = await readActions(db, 0);
    expect(cursor).toBe(2);
    expect(actions).toEqual([
      { seq: 1, ts: expect.any(Number), chat: "@blogs", kind: "send", messageId: 7, text: "<b>hi</b>", silent: true, tier: "minor" },
      { seq: 2, ts: expect.any(Number), chat: "@blogs", kind: "pin", messageId: 7 },
    ]);
  });

  it("since is exclusive and the cursor stays put on an empty read", async () => {
    const db = fakeD1();
    await recordAction(db, { chat: "@c", kind: "send", messageId: 1, text: "a" });
    await recordAction(db, { chat: "@c", kind: "send", messageId: 2, text: "b" });

    const page = await readActions(db, 1);
    expect(page.actions.map((a) => a.seq)).toEqual([2]);
    expect(page.cursor).toBe(2);

    const empty = await readActions(db, 2);
    expect(empty.actions).toEqual([]);
    expect(empty.cursor).toBe(2);
  });

  it("prunes actions past retention on write, and seq never rewinds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    const db = fakeD1();
    await recordAction(db, { chat: "@c", kind: "send", messageId: 1, text: "old" });

    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    await recordAction(db, { chat: "@c", kind: "send", messageId: 2, text: "new" });

    const { actions } = await readActions(db, 0);
    expect(actions.map((a) => [a.seq, a.text])).toEqual([[2, "new"]]);
  });

  it("stores album photos and serves them back by seq and index", async () => {
    const db = fakeD1();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await recordAction(db, {
      chat: "@models",
      kind: "send",
      messageId: 5,
      text: "album",
      photos: [{ bytes, mediaType: "image/webp" }],
    });

    const { actions } = await readActions(db, 0);
    expect(actions[0].photos).toEqual(["/archive/photo/1/0"]);

    const photo = await readPhoto(db, 1, 0);
    expect(photo?.mediaType).toBe("image/webp");
    expect([...photo!.bytes]).toEqual([1, 2, 3]);
    expect(await readPhoto(db, 1, 1)).toBeNull();
  });

  it("swallows storage failures — the post already went out", async () => {
    const broken = { prepare: () => { throw new Error("boom"); } } as unknown as D1Database;
    await expect(
      recordAction(broken, { chat: "@c", kind: "send", messageId: 1, text: "x" }),
    ).resolves.toBeUndefined();
  });
});

describe("/archive endpoint", () => {
  it("refuses a missing, wrong, or unconfigured token", async () => {
    const env = archiveEnv(fakeD1());
    expect((await get(env, "/archive")).status).toBe(403);
    expect((await get(env, "/archive", "Bearer wrong")).status).toBe(403);
    const unconfigured = { ...env, ARCHIVE_READ_SECRET: undefined } as Env;
    expect((await get(unconfigured, "/archive", "Bearer read-secret")).status).toBe(403);
  });

  it("is GET-only and validates since", async () => {
    const env = archiveEnv(fakeD1());
    const post = await worker.fetch(
      new Request("https://w/archive", { method: "POST", headers: auth() }) as never,
      env,
    );
    expect(post.status).toBe(405);
    expect((await get(env, "/archive?since=abc", "Bearer read-secret")).status).toBe(400);
  });

  it("serves the incremental feed and the photo bytes", async () => {
    const db = fakeD1();
    await recordAction(db, {
      chat: "@models",
      kind: "send",
      messageId: 5,
      text: "album",
      photos: [{ bytes: new Uint8Array([9]).buffer, mediaType: "image/webp" }],
    });
    const env = archiveEnv(db);

    const res = await get(env, "/archive?since=0", "Bearer read-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cursor: number; actions: { photos?: string[] }[] };
    expect(body.cursor).toBe(1);
    expect(body.actions[0].photos).toEqual(["/archive/photo/1/0"]);

    const photo = await get(env, "/archive/photo/1/0", "Bearer read-secret");
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/webp");
    expect([...new Uint8Array(await photo.arrayBuffer())]).toEqual([9]);

    expect((await get(env, "/archive/photo/1/5", "Bearer read-secret")).status).toBe(404);
    expect((await get(env, "/archive/nope", "Bearer read-secret")).status).toBe(404);
  });
});

// --- scaffolding ---

afterEach(() => {
  vi.useRealTimers();
});

interface ActionRow {
  seq: number;
  ts: number;
  chat: string;
  kind: string;
  message_id: number;
  text: string | null;
  silent: number | null;
  tier: string | null;
}

interface PhotoRow {
  action_seq: number;
  idx: number;
  media_type: string;
  bytes: number[];
}

/**
 * Implements exactly the statements archive.ts issues, dispatched on SQL text;
 * an unrecognized statement throws so a query change breaks loudly. BLOBs are
 * stored as number arrays — that is what real D1 hands back.
 */
function fakeD1(): D1Database {
  const actions: ActionRow[] = [];
  const photos: PhotoRow[] = [];
  let autoinc = 0;
  let lastRowId = 0;

  function execute(sql: string, args: unknown[]): { rows?: unknown[]; } {
    if (sql.startsWith("INSERT INTO actions")) {
      const [ts, chat, kind, message_id, text, silent, tier] = args as never[];
      actions.push({ seq: ++autoinc, ts, chat, kind, message_id, text, silent, tier });
      lastRowId = autoinc;
      return {};
    }
    if (sql.startsWith("INSERT INTO photos")) {
      const [action_seq, idx, media_type, bytes] = args as [number, number, string, ArrayBuffer];
      photos.push({ action_seq, idx, media_type, bytes: [...new Uint8Array(bytes)] });
      return {};
    }
    if (sql.startsWith("DELETE FROM photos")) {
      const cutoff = args[0] as number;
      const expired = new Set(actions.filter((a) => a.ts < cutoff).map((a) => a.seq));
      remove(photos, (p) => expired.has(p.action_seq));
      return {};
    }
    if (sql.startsWith("DELETE FROM actions")) {
      const cutoff = args[0] as number;
      remove(actions, (a) => a.ts < cutoff);
      return {};
    }
    if (sql.includes("FROM actions a WHERE a.seq >")) {
      const since = args[0] as number;
      const rows = actions
        .filter((a) => a.seq > since)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, 200)
        .map((a) => ({ ...a, photo_count: photos.filter((p) => p.action_seq === a.seq).length }));
      return { rows };
    }
    if (sql.startsWith("SELECT media_type, bytes FROM photos")) {
      const [seq, idx] = args as [number, number];
      const row = photos.find((p) => p.action_seq === seq && p.idx === idx);
      return { rows: row ? [{ media_type: row.media_type, bytes: row.bytes }] : [] };
    }
    throw new Error(`fakeD1: unrecognized statement: ${sql}`);
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              execute(sql, args);
              return { meta: { last_row_id: lastRowId } };
            },
            async all() {
              return { results: execute(sql, args).rows ?? [] };
            },
            async first() {
              return execute(sql, args).rows?.[0] ?? null;
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database;
}

function remove<T>(arr: T[], pred: (item: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1);
}

function archiveEnv(db: D1Database): Env {
  return { ARCHIVE: db, ARCHIVE_READ_SECRET: "read-secret" } as Env;
}

function auth(token = "Bearer read-secret"): Record<string, string> {
  return { authorization: token };
}

async function get(env: Env, path: string, token?: string): Promise<Response> {
  const headers = token ? auth(token) : {};
  return worker.fetch(new Request(`https://w${path}`, { headers }) as never, env);
}
