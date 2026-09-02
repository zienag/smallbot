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
 * Article text from a full HTML page. One <article> is the post (a /news/
 * page); none means <main> is (claude.com blog posts have no <article>);
 * several mean the launch template, whose body sections sit in <main>
 * between an intro <article> and a carousel of customer-quote <article>s —
 * the Fable 5.1 page had 22, and the first alone was a third of the text.
 * Null if the page has neither.
 */
export function articleText(page: string): string | null {
  const articles = [...page.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  const main = page.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1];
  let html: string | undefined;
  if (articles.length === 1) html = articles[0];
  else if (articles.length > 1 && main) {
    html = main.replace(/<article[^>]*>([\s\S]*?)<\/article>/g, (block, inner: string) =>
      /^Quote\b/.test(flatten(inner)) ? " " : block,
    );
  } else html = main ?? articles[0];
  if (!html) return null;
  return flatten(html);
}

function flatten(html: string): string {
  return decodeHTML(
    html
      .replace(/<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/g, " ")
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
