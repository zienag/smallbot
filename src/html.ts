import { decodeHTML } from "entities";

// anthropic.com 403s non-browser user agents; any Mozilla-ish UA passes.
export const BOT_UA = "Mozilla/5.0 (compatible; smallbot/1.0)";

/** Release body HTML → flat text for the LLM: list items become "- ", tags stripped. */
export function htmlToText(html: string): string {
  return decodeHTML(
    html
      .replace(/<li>/g, "- ")
      .replace(/<\/(?:p|li|ul|ol|h\d)>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Article text from a full HTML page: first <article>, else <main>
 * (claude.com blog posts have no <article> tag), null if neither.
 */
export function articleText(page: string): string | null {
  const article =
    page.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1] ??
    page.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1];
  if (!article) return null;
  return decodeHTML(
    article
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Page <title> content without the trailer after «\» or «|». */
export function pageTitle(page: string): string | null {
  const raw = page.match(/<title[^>]*>([^<]*)<\/title>/)?.[1];
  if (!raw) return null;
  return decodeHTML(raw).split(/\s*[\\|]\s*/)[0].trim() || null;
}
