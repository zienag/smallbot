/**
 * openai.com article pages sit behind a Cloudflare JS challenge, so a plain
 * worker fetch gets 403 `cf-mitigated: challenge` — for ~10 hours at a stretch,
 * measured. A real browser solves the challenge, and Browser Run's quick
 * actions give us one without the puppeteer client: `quickAction` needs only
 * the binding and a compatibility date of 2026-03-24 or later.
 */

import { warn } from "./health";

export interface BrowserRun {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
}

/** Free plan allows one quick action per 10 seconds; the caller paces the loop. */
export const QUICK_ACTION_GAP_MS = 10_000;

/** The page's own title — its first heading — when the render carried one. */
export function markdownTitle(markdown: string): string | null {
  const title = markdown.match(/^#\s+(.+?)\s*$/m)?.[1].replace(/\s*\|\s*OpenAI$/, "");
  return title || null;
}

/** Page as markdown, or null when the render failed (quota, rate, redesign). */
export async function fetchPageMarkdown(
  browser: BrowserRun,
  url: string,
): Promise<string | null> {
  try {
    const res = await browser.quickAction("markdown", { url });
    const body = (await res.json()) as { success?: boolean; result?: string };
    if (!res.ok || !body.success || !body.result) {
      warn(`quickAction markdown failed: ${res.status} ${url}`);
      return null;
    }
    return body.result;
  } catch (err) {
    warn(`quickAction markdown failed: ${err} ${url}`);
    return null;
  }
}
