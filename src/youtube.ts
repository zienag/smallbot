import { DIGEST_TASK, type Tier } from "./blogs";
import { structuredFromPrompt } from "./summarize";
import { escapeHtml, formatInline } from "./telegram";

/**
 * YouTube publishes an atom feed per channel — the 15 newest uploads with full
 * descriptions — and it is the only machine-readable surface the channels
 * have. The feed accepts only the channel id; each handle was resolved once by
 * hand from the channel page's canonical link (@claudeofficial is a squatter —
 * the real Claude channel is @claude).
 */
export const YOUTUBE_CHANNELS = [
  { key: "openai", label: "OpenAI YouTube", channelId: "UCXZCJLdBC09xxGZ6gcdrc6A" },
  { key: "anthropic", label: "Anthropic YouTube", channelId: "UCrDwWp7EBBv4NwvScIpBDOA" },
  { key: "claude", label: "Claude YouTube", channelId: "UCV03SRZXJEz-hchIAogeJOg" },
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
