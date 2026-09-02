/**
 * Conditional GETs for the feeds whose servers support them. Downloading a
 * body is what a fetch costs the runtime — the 600 KB changelog was ~9 ms of
 * CPU per tick, a 304 is ~1 ms — so every poll of a feed that has not changed
 * should be a 304.
 *
 * A validator is remembered in two steps: `stage` on the 200, `commit` once
 * the caller has fully consumed the content (every new item posted). A source
 * that stops early — a send failure, the npm gate, the per-tick cap — never
 * commits, so the next tick re-reads the feed and resumes; nothing can be
 * skipped by a 304 that was not already processed.
 */
export const VALIDATORS_KEY = "http_validators";

export interface Validator {
  etag?: string;
  lastModified?: string;
}

export class Validators {
  private readonly pending = new Map<string, Validator>();
  private dirty = false;

  private constructor(private readonly known: Record<string, Validator>) {}

  /** One KV read per tick; every conditional fetch of the tick shares it. */
  static async load(kv: KVNamespace): Promise<Validators> {
    const raw = await kv.get(VALIDATORS_KEY);
    return new Validators(raw ? (JSON.parse(raw) as Record<string, Validator>) : {});
  }

  static empty(): Validators {
    return new Validators({});
  }

  headers(url: string): Record<string, string> {
    const v = this.known[url];
    const out: Record<string, string> = {};
    if (v?.etag) out["If-None-Match"] = v.etag;
    if (v?.lastModified) out["If-Modified-Since"] = v.lastModified;
    return out;
  }

  stage(url: string, res: Response): void {
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    if (etag || lastModified) this.pending.set(url, { etag, lastModified });
  }

  commit(url: string): void {
    const v = this.pending.get(url);
    if (!v) return;
    this.pending.delete(url);
    this.known[url] = v;
    this.dirty = true;
  }

  /** One KV write per tick, and only when a commit changed something. */
  async save(kv: KVNamespace): Promise<void> {
    if (!this.dirty) return;
    await kv.put(VALIDATORS_KEY, JSON.stringify(this.known));
    this.dirty = false;
  }
}

/**
 * GET with the URL's conditional headers. Null means 304: the content is the
 * one whose validator was committed, and it was processed in full. Without
 * validators (a first run, a reset cursor) it is a plain GET.
 */
export async function conditionalFetch(
  url: string,
  validators: Validators | undefined,
  headers: Record<string, string> = {},
): Promise<Response | null> {
  const res = await fetch(url, { headers: { ...headers, ...(validators?.headers(url) ?? {}) } });
  if (res.status === 304) return null;
  validators?.stage(url, res);
  return res;
}
