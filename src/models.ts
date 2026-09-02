import Anthropic from "@anthropic-ai/sdk";
import { decodeHTML } from "entities";
import { BOT_UA, articleText, pageTitle } from "./html";
import { structuredFromPrompt, summaryFromPrompt } from "./summarize";
import { escapeHtml, formatInline } from "./telegram";

export const KNOWN_MODELS_KEY = "known_models";
const NEWS_BASE = "https://www.anthropic.com/news";
export const SITEMAP_URL = "https://www.anthropic.com/sitemap.xml";
const PRESS_TEXT_LIMIT = 12000;

export interface ModelInfo {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface ArticleImage {
  url: string;
  alt: string;
}

export interface FetchedImage {
  url: string;
  alt: string;
  bytes: ArrayBuffer;
  mediaType: string;
}

export interface PressRelease {
  url: string;
  title: string;
  text: string;
  images: ArticleImage[];
}

export interface ModelAnnouncement {
  model: ModelInfo;
  press?: { url: string; title: string; bullets: string[]; photos: FetchedImage[] };
}

/** One plain GET, like the OpenAI side: the SDK's request machinery costs a tick CPU it can skip. */
export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`models fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data: { id: string; display_name: string; created_at: string }[];
  };
  return body.data.map((m) => ({ id: m.id, displayName: m.display_name, createdAt: m.created_at }));
}

/** Dated snapshots don't get press releases — only aliases are enriched. */
export function isDatedSnapshot(id: string): boolean {
  return /-\d{8}$/.test(id);
}

/**
 * Point releases are announced at /news/<alias> (verified: claude-opus-4-8,
 * claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1). Family launches use a
 * combined slug, found via sitemap.xml — the /news index only shows recent
 * posts so announcements age out of it fast, while the sitemap is complete —
 * and not always under /news/: the Fable 5.1 launch lives at
 * /claude-fable-and-mythos-5-1. A slug matches when it carries the family
 * token and exactly the model's version: `5-1` is not `5`, or the 5.1 model
 * would pick up the Fable 5 launch page, as it did on 2026-09-01. /news/
 * slugs beat top-level ones, then the freshest lastmod wins; `/news/claude-N`
 * is the family launch of a major without its own page.
 */
export async function findPressRelease(
  modelId: string,
  fetchPage: (url: string) => Promise<string | null> = fetchOk,
): Promise<PressRelease | null> {
  const direct = toPress(`${NEWS_BASE}/${modelId}`, await fetchPage(`${NEWS_BASE}/${modelId}`));
  if (direct) return direct;

  const m = modelId.match(/^claude-([a-z]+)-(\d+(?:-\d+)*)$/);
  if (!m) return null;
  const [, family, version] = m;
  const major = version.split("-")[0];
  const sitemap = await fetchPage(SITEMAP_URL);
  if (!sitemap) return null;
  const matches: { url: string; lastmod: string; news: boolean }[] = [];
  for (const [, block] of sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const url = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!url) continue;
    const slug = url.replace(/^https:\/\/www\.anthropic\.com/, "");
    const news = slug.startsWith("/news/");
    const path = news ? slug.slice("/news/".length) : slug.slice(1);
    if (path.includes("/") || !path.startsWith("claude")) continue;
    if (!(slugNamesVersion(path, family, version) || (news && path === `claude-${major}`))) continue;
    matches.push({ url, lastmod: block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? "", news });
  }
  const best = matches.sort(
    (a, b) => Number(b.news) - Number(a.news) || b.lastmod.localeCompare(a.lastmod),
  )[0];
  if (!best) {
    console.log(`no press release found for ${modelId}`);
    return null;
  }
  return toPress(best.url, await fetchPage(best.url));
}

/** The slug's numeric runs, each taken whole: `fable-5-mythos-5` has `5` and `5`, never `5-1`. */
export function slugNamesVersion(slug: string, family: string, version: string): boolean {
  const tokens = slug.split("-");
  if (!tokens.includes(family)) return false;
  const runs: string[] = [];
  let run: string[] = [];
  for (const t of [...tokens, ""]) {
    if (/^\d+$/.test(t)) run.push(t);
    else if (run.length > 0) {
      runs.push(run.join("-"));
      run = [];
    }
  }
  return runs.includes(version);
}

function toPress(url: string, page: string | null): PressRelease | null {
  if (!page) return null;
  const text = articleText(page);
  if (!text) return null;
  return {
    url,
    title: pageTitle(page) ?? "Press release",
    text: text.slice(0, PRESS_TEXT_LIMIT),
    images: articleImages(page),
  };
}

/**
 * Content images of the article. The decorative hero is dropped by its
 * heroImage class. Take the first srcSet URL — the /_next/image proxy serving
 * compressed webp; CDN originals can be many megabytes.
 */
export function articleImages(page: string): ArticleImage[] {
  const article = page.match(/<article[^>]*>([\s\S]*?)<\/article>/)?.[1];
  if (!article) return [];
  const out: ArticleImage[] = [];
  const seen = new Set<string>();
  for (const [, attrs] of article.matchAll(/<img([^>]*)>/g)) {
    if (attrs.includes("heroImage")) continue;
    const src = attrs.match(/srcSet="([^"\s]+)/i)?.[1] ?? attrs.match(/src="([^"]+)"/)?.[1];
    if (!src) continue;
    const url0 = decodeHTML(src);
    const url = url0.startsWith("/") ? `https://www.anthropic.com${url0}` : url0;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, alt: attrs.match(/alt="([^"]*)"/)?.[1] ?? "" });
    if (out.length >= 8) break;
  }
  return out;
}

async function fetchOk(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: { "User-Agent": BOT_UA } });
  return res.ok ? res.text() : null;
}

const MAX_IMAGE_BYTES = 3_500_000; // vision API per-image limit
// The only types the vision API accepts. Without an explicit Accept header
// /_next/image serves avif, which the API rejects.
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function fetchImages(images: ArticleImage[]): Promise<FetchedImage[]> {
  const fetched: FetchedImage[] = [];
  for (const img of images) {
    const res = await fetch(img.url, {
      headers: { "User-Agent": BOT_UA, Accept: "image/webp,image/png,image/jpeg" },
    });
    if (!res.ok) continue;
    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!IMAGE_TYPES.includes(mediaType)) continue;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) continue;
    fetched.push({ ...img, bytes, mediaType });
  }
  return fetched;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const IMAGE_PROMPT = (title: string) => `\
You are choosing which images from the press release "${title}" to attach to a \
Telegram digest for engineers who follow AI news. Below the images are numbered \
starting from 1. Pick up to 3, most important first: real data charts with axes \
and trends beat tables of benchmark numbers, which beat everything else; skip \
decorative or artistic images entirely. Return {"indexes": []} if nothing is \
informative.`;

/** Image selection via a vision classifier (sonnet — cheap and sufficient). */
export async function pickImportantImages(
  apiKey: string,
  kv: KVNamespace,
  title: string,
  fetched: FetchedImage[],
): Promise<FetchedImage[]> {
  if (fetched.length <= 1) return fetched;
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: IMAGE_PROMPT(title) }];
  fetched.forEach((img, i) => {
    content.push({ type: "text", text: `Image ${i + 1}${img.alt ? ` (alt: ${img.alt})` : ""}:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType as "image/png",
        data: toBase64(img.bytes),
      },
    });
  });
  const res = await structuredFromPrompt<{ indexes: number[] }>(
    apiKey,
    kv,
    content,
    {
      type: "object",
      properties: { indexes: { type: "array", items: { type: "integer" } } },
      required: ["indexes"],
      additionalProperties: false,
    },
    "sonnet",
  );
  return res.indexes
    .map((n) => fetched[n - 1])
    .filter(Boolean)
    .slice(0, 3);
}

const PRESS_PROMPT = (text: string) => `\
You are writing a short digest of an Anthropic model announcement for a Telegram \
channel whose readers are engineers who follow AI news daily.

Press release text (extracted from the page, may contain navigation noise):
${text}

Every model launch claims the model is smarter, tops benchmarks, and is the \
best yet — readers assume that by default, so NEVER include such generic \
claims. Pick ONLY the 2-4 most unusual facts specific to THIS announcement — \
things a reader wouldn't guess from "new model released": surprising \
capabilities or failure modes, concrete pricing moves, unusual safety \
mechanisms or access schemes, caveats, incidents, odd details. Concrete \
numbers beat adjectives. The digest is a photo caption, so it must be TIGHT: \
each bullet under 12 words, the whole digest under 400 characters. Telegraphic \
style is fine — drop filler words. Write model names as plain text (no \
backticks or code formatting). Write in English.`;

/**
 * For each new model, tries to find and summarize its press release; any
 * enrichment error is swallowed — the announcement matters more. One press
 * release is never duplicated across models of the same run.
 */
export async function buildAnnouncements(
  apiKey: string,
  kv: KVNamespace,
  fresh: ModelInfo[],
): Promise<ModelAnnouncement[]> {
  const announcements: ModelAnnouncement[] = [];
  const seenUrls = new Set<string>();
  for (const model of fresh) {
    let press: ModelAnnouncement["press"];
    if (!isDatedSnapshot(model.id)) {
      try {
        const found = await findPressRelease(model.id);
        if (found && !seenUrls.has(found.url)) {
          seenUrls.add(found.url);
          const summary = await summaryFromPrompt(apiKey, kv, PRESS_PROMPT(found.text));
          summary.bullets = summary.bullets.slice(0, 4);
          let photos: FetchedImage[] = [];
          try {
            photos = await pickImportantImages(apiKey, kv, found.title, await fetchImages(found.images));
          } catch (err) {
            console.log(`image selection failed for ${model.id}: ${err}`);
          }
          press = { url: found.url, title: found.title, bullets: summary.bullets, photos };
        }
      } catch (err) {
        console.log(`press release lookup failed for ${model.id}: ${err}`);
      }
    }
    announcements.push({ model, press });
  }
  return announcements;
}

export function formatNewModelsPost(announcements: ModelAnnouncement[]): string {
  const lines = announcements.map(({ model }) => {
    const date = model.createdAt ? ` (${model.createdAt.slice(0, 10)})` : "";
    return `• <code>${escapeHtml(model.id)}</code> — ${escapeHtml(model.displayName)}${date}`;
  });
  const sections = [`<b>New models in the Anthropic API</b>\n\n${lines.join("\n")}`];
  for (const { press } of announcements) {
    if (!press) continue;
    sections.push(
      `<b><a href="${press.url}">${escapeHtml(press.title)}</a></b>\n${press.bullets
        .map((b) => `• ${formatInline(b)}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
