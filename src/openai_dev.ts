import { escapeHtml, formatInline } from "./telegram";

/**
 * The developer half of OpenAI — docs, Codex and API posts — lives on Vercel
 * with no bot protection and a markdown twin of every page, so this source
 * needs neither a browser nor a browser-ish UA. It shares the blog channel
 * with the news feed, the way the Anthropic channel carries news and
 * engineering together.
 */
export const OPENAI_DEV_INDEX_URL = "https://developers.openai.com/blog/llms.txt";
export const OPENAI_DEV_SEEN_KEY = "openai_dev_blog_seen";

export interface DevPost {
  title: string;
  mdUrl: string; // markdown twin, what we read
  url: string; // human page, what the post links to
}

/** Index lines are `- [Title](url.md): description`; the combined dump is not a post. */
export function parseDevIndex(text: string): DevPost[] {
  const out: DevPost[] = [];
  for (const [, title, mdUrl] of text.matchAll(/^- \[([^\]]+)\]\((https:\/\/[^)]+\.md)\)/gm)) {
    out.push({ title, mdUrl, url: mdUrl.replace(/\.md$/, "") });
  }
  return out;
}

export async function fetchDevPosts(): Promise<DevPost[]> {
  const res = await fetch(OPENAI_DEV_INDEX_URL);
  if (!res.ok) throw new Error(`openai dev index fetch failed: ${res.status}`);
  return parseDevIndex(await res.text());
}

// Every markdown twin opens with the same pointer at the docs index.
const BOILERPLATE = /^> For the complete documentation index[^\n]*\n/m;

export async function fetchDevPostText(post: DevPost): Promise<string | null> {
  const res = await fetch(post.mdUrl);
  if (!res.ok) {
    console.log(`openai dev post fetch failed: ${res.status} ${post.mdUrl}`);
    return null;
  }
  return (await res.text()).replace(BOILERPLATE, "").trim();
}

export function formatDevPost(post: DevPost, bullets: string[]): string {
  const head = `<b>OpenAI Developers: <a href="${post.url}">${escapeHtml(post.title)}</a></b>`;
  if (bullets.length === 0) return head;
  return `${head}\n\n${bullets.map((b) => `• ${formatInline(b)}`).join("\n")}`;
}
