import { DIGEST_TASK, TIER_CRITERIA, type Tier } from "./blogs";
import { structuredFromPrompt } from "./summarize";
import { escapeHtml, formatInline } from "./telegram";

/**
 * YouTube publishes an atom feed per channel — the 15 newest uploads with full
 * descriptions — and it is the only machine-readable surface the channels
 * have. The feed accepts only the channel id; each handle was resolved once by
 * hand from the channel page's canonical link (@claudeofficial is a squatter —
 * the real Claude channel is @claude). The group names the company whose cron
 * carries the channel and whose blog channel gets the post.
 */
export const YOUTUBE_CHANNELS = [
  { key: "openai", group: "openai", label: "OpenAI YouTube", channelId: "UCXZCJLdBC09xxGZ6gcdrc6A" },
  { key: "anthropic", group: "anthropic", label: "Anthropic YouTube", channelId: "UCrDwWp7EBBv4NwvScIpBDOA" },
  { key: "claude", group: "anthropic", label: "Claude YouTube", channelId: "UCV03SRZXJEz-hchIAogeJOg" },
] as const;

export type YouTubeChannel = (typeof YOUTUBE_CHANNELS)[number];

export function youtubeSeenKey(channel: YouTubeChannel): string {
  return `youtube_seen:${channel.key}`;
}

export interface Video {
  videoId: string;
  title: string;
  url: string;
  published: number | null; // epoch ms from <published>
  description: string;
}

/** Feed order: newest first. Only the 15 most recent uploads. */
export function parseVideoFeed(xml: string): Video[] {
  const out: Video[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const field = (name: string) => {
      const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m?.[1].trim() ?? "";
    };
    const videoId = field("yt:videoId");
    if (!videoId) continue;
    const published = Date.parse(field("published"));
    out.push({
      videoId,
      title: field("title"),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      published: Number.isNaN(published) ? null : published,
      description: field("media:description"),
    });
  }
  return out;
}

export async function fetchVideoFeed(channelId: string): Promise<Video[]> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`youtube feed fetch failed: ${res.status} ${channelId}`);
  return parseVideoFeed(await res.text());
}

/**
 * The feed carries no history, but the seen-set alone would still replay
 * whatever YouTube resurfaces; publication date is the second gate, same
 * window as the blog watches. Undated counts as stale.
 */
export const MAX_VIDEO_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function isRecentVideo(video: Video, now: number): boolean {
  return video.published !== null && now - video.published <= MAX_VIDEO_AGE_MS;
}

/**
 * A channel uploads a launch's videos in a burst — ten in one minute on
 * 2026-09-01 — and a tick that catches the burst half-way would post half of
 * it as one topic and the rest as another. The batch is judged only once
 * nothing has arrived for this long; with ticks every 15 minutes a video
 * shows up 5–20 minutes after upload.
 */
export const MIN_VIDEO_AGE_MS = 5 * 60 * 1000;

export function isSettled(videos: Video[], now: number): boolean {
  return videos.every((v) => v.published === null || now - v.published >= MIN_VIDEO_AGE_MS);
}

/** Enough to tell two links to one page apart from two pages. */
export function normalizeUrl(url: string): string {
  return url
    .replace(/^http:/, "https:")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/**
 * The posted article a video accompanies: the first link in its description
 * that the channel has already posted (the map is normalized url → the url as
 * posted). Such a video joins the article's post instead of getting its own.
 */
export function companionArticle(video: Video, posted: Map<string, string>): string | null {
  for (const [url] of video.description.matchAll(/https?:\/\/[^\s<>")\]]+/g)) {
    // Prose punctuation after a link is not part of it.
    const hit = posted.get(normalizeUrl(url.replace(/[.,;:!?]+$/, "")));
    if (hit) return hit;
  }
  return null;
}

/** The line a companion video adds to its article's post. */
export function companionLine(video: Video): string {
  return `▶ <a href="${video.url}">${escapeHtml(video.title)}</a>`;
}

export interface VideoGroup {
  title: string;
  tier: Tier;
  videos: Video[];
}

/** One post for a topic's videos: the LLM's title, then the titles as links. */
export function formatRoundupPost(title: string, label: string, videos: Video[]): string {
  const head = `<b>${escapeHtml(title)}</b> · ${videos.length} videos on ${escapeHtml(label)}`;
  return `${head}\n\n${videos.map((v) => `• <a href="${v.url}">${escapeHtml(v.title)}</a>`).join("\n")}`;
}

const GROUP_PROMPT = (label: string, videos: Video[]) => `\
${videos.length} new videos appeared on the official ${label} channel within the \
same hour. They go to a Telegram channel whose readers are engineers who follow \
AI news daily, and those readers want one post per topic, not one per video: a \
launch's series of demos is one topic, a run of tutorials for one product is \
one topic, a video that stands on its own is a topic of one. Group the videos \
by topic, give each group of several a short title in English that names the \
topic (a group of one keeps the video's own title), and use every video id \
exactly once.

Also assign each group an importance tier:
${TIER_CRITERIA}

The videos, one per line as id | title | description:
${videos.map((v) => `${v.videoId} | ${v.title} | ${v.description.slice(0, 300).replace(/\s+/g, " ")}`).join("\n")}`;

const GROUP_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          tier: { type: "string", enum: ["major", "normal", "minor"] },
          videoIds: { type: "array", items: { type: "string" } },
        },
        required: ["title", "tier", "videoIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

/**
 * Splits a settled batch into topics. Facts stay mechanical — which videos
 * exist, that they are new — and only the grouping is editorial, like the
 * tiers. An id the model invents is dropped, one it forgets becomes a group
 * of its own, so every real video is posted exactly once.
 */
export async function groupVideos(
  apiKey: string,
  kv: KVNamespace,
  label: string,
  videos: Video[],
): Promise<VideoGroup[]> {
  const byId = new Map(videos.map((v) => [v.videoId, v]));
  const res = await structuredFromPrompt<{
    groups: { title: string; tier: Tier; videoIds: string[] }[];
  }>(apiKey, kv, GROUP_PROMPT(label, videos), GROUP_SCHEMA);
  const groups: VideoGroup[] = [];
  const placed = new Set<string>();
  for (const g of res.groups) {
    const members = g.videoIds
      .filter((id) => byId.has(id) && !placed.has(id))
      .map((id) => byId.get(id)!);
    for (const v of members) placed.add(v.videoId);
    if (members.length > 0) groups.push({ title: g.title, tier: g.tier, videos: members });
  }
  for (const v of videos) {
    if (!placed.has(v.videoId)) groups.push({ title: v.title, tier: "normal", videos: [v] });
  }
  return groups;
}

/**
 * The feed does not mark Shorts, but /shorts/<id> answers 200 for one and a
 * redirect to /watch for a regular video — a fact, not a guess. Errors count
 * as "not a Short": the failure mode is a posted promo cut, never a dropped
 * video.
 */
export async function isShort(videoId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD",
      redirect: "manual",
    });
    return res.status === 200;
  } catch (err) {
    console.log(`shorts probe failed for ${videoId}: ${err}`);
    return false;
  }
}

// The description is the only text we have — the video itself is not watched.
const VIDEO_PROMPT = (label: string, video: Video) => `\
You are writing a short digest of a new video on the official ${label} channel \
for a Telegram channel whose readers are engineers who follow AI news daily. \
Only the video's title and description are available, not the video itself — \
say only what they support, and leave the bullets empty when the description \
gives nothing beyond the title.

Video title: ${video.title}

Video description:
${video.description.slice(0, 4000)}

${DIGEST_TASK}`;

const VIDEO_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["major", "normal", "minor"] },
    bullets: { type: "array", items: { type: "string" } },
  },
  required: ["tier", "bullets"],
  additionalProperties: false,
};

export async function digestVideo(
  apiKey: string,
  kv: KVNamespace,
  label: string,
  video: Video,
): Promise<{ tier: Tier; bullets: string[] }> {
  const digest = await structuredFromPrompt<{ tier: Tier; bullets: string[] }>(
    apiKey,
    kv,
    VIDEO_PROMPT(label, video),
    VIDEO_SCHEMA,
  );
  return { tier: digest.tier, bullets: digest.bullets.slice(0, 4) };
}

/**
 * No source line, unlike the blog posts: the link preview card (enabled only
 * for these posts) already says it is YouTube and names the channel.
 * Owner-approved shape.
 */
export function formatVideoPost(video: Video, bullets: string[]): string {
  const head = `<b><a href="${video.url}">${escapeHtml(video.title)}</a></b>`;
  if (bullets.length === 0) return head;
  return `${head}\n\n${bullets.map((b) => `• ${formatInline(b)}`).join("\n")}`;
}
