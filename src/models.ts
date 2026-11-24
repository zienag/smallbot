import Anthropic from "@anthropic-ai/sdk";
import { decodeHTML } from "entities";
import { type Candidate, confirmAnnouncement, shortlistAnnouncements } from "./announcement";
import { warn } from "./health";
import { BOT_UA, type PageMemo, articleText, pageLinks, pageTitle } from "./html";
import { structuredFromPrompt, summaryFromPrompt } from "./summarize";
import { escapeHtml, formatInline } from "./telegram";

export const KNOWN_MODELS_KEY = "known_models";
export const MODEL_FOLLOWUPS_KEY = "model_followups";
const ORIGIN = "https://www.anthropic.com";
const NEWS_INDEX_URL = `${ORIGIN}/news`;
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;
const PRESS_TEXT_LIMIT = 12000;
// A featured card's anchor wraps its whole teaser.
const CANDIDATE_TITLE_LIMIT = 160;

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

export interface PressDigest {
  url: string;
  title: string;
  bullets: string[];
  photos: FetchedImage[];
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

/** Dated snapshots ride on their alias's article and are never matched themselves. */
export function isDatedSnapshot(id: string): boolean {
  return /-\d{8}$/.test(id);
}

/**
 * Where a launch article can turn up, for the matcher to choose from. The news
 * index features a launch the day it ships, under any address (the Fable 5.2
 * page is /claude-fable-and-mythos-5-2, outside /news/). The sitemap is
 * complete but hours late — that page was not in it half an hour after launch —
 * and has no titles, so it contributes the addresses that carry a new model's
 * family name: the index only shows recent posts, and a model can reach the
 * API long after its article has rotated out.
 */
export function pressCandidates(models: ModelInfo[], newsHtml: string | null, sitemap: string | null): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const link of newsHtml ? pageLinks(newsHtml, ORIGIN) : []) {
    if (link.url === ORIGIN || link.url === NEWS_INDEX_URL) continue;
    out.set(link.url, { url: link.url, title: link.text.slice(0, CANDIDATE_TITLE_LIMIT) });
  }
  const families = new Set(models.map((m) => m.id.match(/^claude-([a-z]+)-/)?.[1]).filter(Boolean));
  for (const [, url] of sitemap?.matchAll(/<loc>([^<]+)<\/loc>/g) ?? []) {
    if (out.has(url) || !url.startsWith(`${ORIGIN}/`)) continue;
    const tokens = url.slice(ORIGIN.length).split(/[/-]/);
    if (tokens.some((t) => families.has(t))) out.set(url, { url, title: "" });
  }
  return [...out.values()];
}

/** The news index and the sitemap; either may be missing, the other still serves. */
export async function fetchPressCandidates(models: ModelInfo[], pages: PageMemo): Promise<Candidate[]> {
  const news = await fetchOk(NEWS_INDEX_URL);
  if (news) pages.set(NEWS_INDEX_URL, news);
  return pressCandidates(models, news, await fetchOk(SITEMAP_URL));
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

export interface PressMatch {
  press: PressDigest[];
  matched: string[]; // ids an attached article announces
  asked: string[]; // candidates that got a verdict; a page that would not load is asked again
}

/**
 * The articles that announce `models`, among `candidates`. A page is attached
 * only once its own text was read and names the model. Photos are for a first
 * post; an edit of a text message cannot carry them.
 */
export async function matchPress(
  apiKey: string,
  kv: KVNamespace,
  models: ModelInfo[],
  candidates: Candidate[],
  withPhotos: boolean,
  fetchPage: (url: string) => Promise<string | null> = fetchOk,
): Promise<PressMatch> {
  const out: PressMatch = { press: [], matched: [], asked: [] };
  const refs = models.map((m) => ({ id: m.id, name: m.displayName }));
  if (refs.length === 0 || candidates.length === 0) return out;
  const picks = await shortlistAnnouncements(apiKey, kv, "Anthropic", refs, candidates);
  const unread = new Set<string>();
  for (const url of new Set([...picks.values()].map((c) => c.url))) {
    const open = refs.filter((m) => !out.matched.includes(m.id));
    const found = open.length > 0 ? toPress(url, await fetchPage(url)) : null;
    if (!found) {
      unread.add(url);
      continue;
    }
    const announced = await confirmAnnouncement(apiKey, kv, "Anthropic", open, found);
    if (announced.length === 0) continue;
    const summary = await summaryFromPrompt(apiKey, kv, PRESS_PROMPT(found.text));
    let photos: FetchedImage[] = [];
    if (withPhotos) {
      try {
        photos = await pickImportantImages(apiKey, kv, found.title, await fetchImages(found.images));
      } catch (err) {
        warn(`image selection failed for ${url}: ${err}`);
      }
    }
    out.press.push({ url: found.url, title: found.title, bullets: summary.bullets.slice(0, 4), photos });
    out.matched.push(...announced);
  }
  out.asked = candidates.map((c) => c.url).filter((url) => !unread.has(url));
  return out;
}

export function formatNewModelsPost(models: ModelInfo[], press: Omit<PressDigest, "photos">[] = []): string {
  const lines = models.map((model) => {
    const date = model.createdAt ? ` (${model.createdAt.slice(0, 10)})` : "";
    return `• <code>${escapeHtml(model.id)}</code> — ${escapeHtml(model.displayName)}${date}`;
  });
  const sections = [`<b>New models in the Anthropic API</b>\n\n${lines.join("\n")}`];
  for (const p of press) {
    sections.push(
      `<b><a href="${p.url}">${escapeHtml(p.title)}</a></b>\n${p.bullets.map((b) => `• ${formatInline(b)}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
