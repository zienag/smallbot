import {
  ANTHROPIC_BLOG_SEEN_KEY,
  type BlogEntry,
  type Tier,
  digestArticle,
  digestArticleByUrl,
  digestBlogPost,
  fetchAllBlogEntries,
  formatBlogPost,
} from "./blogs";
import { type BrowserRun, QUICK_ACTION_GAP_MS, fetchPageMarkdown } from "./browser";
import { fetchChangelog } from "./changelog";
import { fetchCodexReleases } from "./codex";
import {
  KNOWN_MODELS_KEY,
  buildAnnouncements,
  formatNewModelsPost,
  listModels,
} from "./models";
import {
  OPENAI_BLOG_SEEN_KEY,
  type NewsItem,
  articleSlug,
  classifyTier,
  fetchNewsListSlugs,
  fetchOpenAiNews,
  formatOpenAiBlogPost,
  formatOpenAiModelPost,
  isListed,
  isRecent,
} from "./openai_news";
import {
  OPENAI_KNOWN_MODELS_KEY,
  type OpenAiArticle,
  type OpenAiModel,
  findAnnouncement,
  formatNewOpenAiModelsPost,
  listOpenAiModels,
} from "./openai_models";
import {
  type DevPost,
  OPENAI_DEV_SEEN_KEY,
  fetchDevPostText,
  fetchDevPosts,
  formatDevPost,
} from "./openai_dev";
import { fetchNpmLatest } from "./npm";
import {
  YOUTUBE_CHANNELS,
  type YouTubeChannel,
  digestVideo,
  fetchVideoFeed,
  formatVideoPost,
  isRecentVideo,
  isShort,
  youtubeSeenKey,
} from "./youtube";
import {
  type Incident,
  STATUS_INCIDENTS_KEY,
  type StatusState,
  fetchIncidents,
  formatIncidentCard,
  formatUpdateDm,
  isHighImpact,
  pendingUpdates,
  pruneState,
  seedState,
} from "./status";
import { recordAction, readActions, readPhoto } from "./archive";
import { SUBS_PREFIX, handleTelegramUpdate, notifySubscribers } from "./status_bot";
import { summarize } from "./summarize";
import {
  CAPTION_LIMIT,
  type InlineKeyboard,
  buildPost,
  changelogAnchorUrl,
  editMessageText,
  pinMessage,
  sendAlbum,
  sendMessage,
  unpinMessage,
} from "./telegram";
import { compareVersions } from "./version";

export interface Env {
  RELEASES: KVNamespace;
  // Append-only archive of channel actions, read back via /archive (issue #2).
  ARCHIVE: D1Database;
  // Real browser on the edge — how openai.com article pages get read at all
  // (src/browser.ts). No client library, just the binding.
  BROWSER: BrowserRun;
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  // Read-only use: the model list is what tells us OpenAI shipped something.
  OPENAI_API_KEY?: string;
  TRIGGER_SECRET: string;
  // Grants archive reads only — deliberately not TRIGGER_SECRET, which can
  // post. Whitespace-separated list, one token per consumer.
  ARCHIVE_READ_SECRET?: string;
  TELEGRAM_CHAT_ID: string;
  // A source with no channel configured is simply off.
  TELEGRAM_CODEX_CHAT_ID?: string;
  TELEGRAM_MODELS_CHAT_ID?: string;
  TELEGRAM_ANTHROPIC_BLOG_CHAT_ID?: string;
  TELEGRAM_OPENAI_BLOG_CHAT_ID?: string;
  TELEGRAM_STATUS_CHAT_ID?: string;
  // The status channel runs on its own bot (@anthropic_status_watch_bot): it
  // owns the cards, so Follow-button callbacks and subscriber DMs land on its
  // webhook, not on Bipozavr.
  TELEGRAM_STATUS_BOT_TOKEN?: string;
  TELEGRAM_STATUS_BOT_USERNAME?: string;
  // The owner's DM with the bot: where /run?preview=1 delivers a force-posted
  // message instead of the live channel. A secret — the repo is public and the
  // numeric id is personal.
  TELEGRAM_OWNER_CHAT_ID?: string;
  STATUS_WEBHOOK_SECRET?: string;
  DRY_RUN?: string;
}

const MAX_PER_RUN = 5;

interface FeedRelease {
  version: string;
  url: string;
  notes: string;
}

interface FeedSource {
  key: string; // value of the /run source param
  product: string; // post header
  kvKey: string;
  npmPkg: string;
  chatId: string | undefined;
  quoteNotes: boolean;
  fetch(): Promise<FeedRelease[]>; // any order — the pipeline sorts
}

function feedSources(env: Env): FeedSource[] {
  return [
    {
      key: "claude",
      product: "Claude Code",
      kvKey: "last_posted_version",
      npmPkg: "@anthropic-ai/claude-code",
      chatId: env.TELEGRAM_CHAT_ID,
      quoteNotes: true,
      fetch: async () =>
        (await fetchChangelog()).map((r) => ({ ...r, url: changelogAnchorUrl(r.version) })),
    },
    {
      key: "codex",
      product: "Codex",
      kvKey: "codex_last_posted_version",
      npmPkg: "@openai/codex",
      chatId: env.TELEGRAM_CODEX_CHAT_ID,
      // Release body is converted HTML full of PR links, nothing worth quoting.
      quoteNotes: false,
      fetch: fetchCodexReleases,
    },
  ];
}

async function postRelease(
  env: Env,
  source: FeedSource,
  release: FeedRelease,
  dryRun: boolean,
  previewTo?: string,
): Promise<void> {
  const summary = await summarize(
    env.ANTHROPIC_API_KEY,
    env.RELEASES,
    source.product,
    release.version,
    release.notes,
  );
  const post = buildPost({
    product: source.product,
    version: release.version,
    url: release.url,
    summary,
    notes: source.quoteNotes ? release.notes : undefined,
  });
  if (previewTo) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, previewTo, post);
    return;
  }
  if (dryRun) {
    console.log(`DRY_RUN: would post ${source.product} ${release.version} (${post.length} chars):\n${post}`);
    return;
  }
  const messageId = await sendMessage(env.TELEGRAM_BOT_TOKEN, source.chatId!, post);
  await recordAction(env.ARCHIVE, { chat: source.chatId!, kind: "send", messageId, text: post });
}

async function runFeed(env: Env, source: FeedSource, dryRun: boolean): Promise<string> {
  const releases = await source.fetch();
  const npmLatest = await fetchNpmLatest(source.npmPkg);
  const lastPosted = await env.RELEASES.get(source.kvKey);
  const published = releases
    .filter((r) => compareVersions(r.version, npmLatest) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));

  // First run: only the newest published version, no history.
  const candidates = lastPosted
    ? published
        .filter((r) => compareVersions(r.version, lastPosted) > 0)
        .sort((a, b) => compareVersions(a.version, b.version))
        .slice(0, MAX_PER_RUN)
    : published.slice(0, 1);

  if (candidates.length === 0) {
    return `${source.key}: nothing to post (last=${lastPosted}, npm=${npmLatest})`;
  }

  const posted: string[] = [];
  for (const release of candidates) {
    await postRelease(env, source, release, dryRun);
    if (!dryRun) await env.RELEASES.put(source.kvKey, release.version);
    posted.push(release.version);
  }
  return `${source.key}: posted ${posted.join(", ")}${dryRun ? " (dry)" : ""}`;
}

async function watchAnthropicModels(env: Env, dryRun: boolean): Promise<string> {
  const models = await listModels(env.ANTHROPIC_API_KEY);
  const knownRaw = await env.RELEASES.get(KNOWN_MODELS_KEY);
  if (!knownRaw) {
    if (dryRun) return `models: would seed ${models.length} known (dry)`;
    await env.RELEASES.put(KNOWN_MODELS_KEY, JSON.stringify(models.map((m) => m.id)));
    return `models: seeded ${models.length} known, nothing posted`;
  }
  const known = new Set(JSON.parse(knownRaw) as string[]);
  const fresh = models.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return "models: nothing new";

  const announcements = await buildAnnouncements(env.ANTHROPIC_API_KEY, env.RELEASES, fresh);
  const post = formatNewModelsPost(announcements);
  const ids = fresh.map((m) => m.id).join(", ");
  if (dryRun) {
    console.log(`DRY_RUN: would post new models:\n${post}`);
    return `models: would post ${ids} (dry)`;
  }
  await postModelsMessage(env, post, announcements);
  await env.RELEASES.put(
    KNOWN_MODELS_KEY,
    JSON.stringify([...known, ...fresh.map((m) => m.id)]),
  );
  return `models: posted ${ids}`;
}

// One message: an album with a caption. No photos, caption over the limit,
// or album failure → plain text: the announcement matters more than photos.
async function postModelsMessage(
  env: Env,
  post: string,
  announcements: { press?: { photos: { bytes: ArrayBuffer; mediaType: string }[] } }[],
  previewTo?: string,
): Promise<void> {
  const chatId = previewTo ?? env.TELEGRAM_MODELS_CHAT_ID!;
  const photos = announcements.flatMap((a) => a.press?.photos ?? []).slice(0, 10);
  if (photos.length > 0 && post.length <= CAPTION_LIMIT) {
    try {
      const messageId = await sendAlbum(env.TELEGRAM_BOT_TOKEN, chatId, post, photos);
      if (!previewTo)
        await recordAction(env.ARCHIVE, { chat: chatId, kind: "send", messageId, text: post, photos });
      return;
    } catch (err) {
      console.log(`album failed, falling back to plain text: ${err}`);
    }
  }
  const messageId = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, post);
  if (!previewTo)
    await recordAction(env.ARCHIVE, { chat: chatId, kind: "send", messageId, text: post });
}

/**
 * The OpenAI half of the model channel, mirroring the Anthropic one: a new id in
 * /v1/models is the trigger, and the news feed only enriches what the diff
 * already established. The feed used to be the trigger, with an LLM deciding
 * which item was a launch — it announced an engineering retrospective as a model
 * release, and no wording fixes a mechanism that guesses at a fact.
 */
async function watchOpenAiModels(env: Env, dryRun: boolean): Promise<string> {
  const models = await listOpenAiModels(env.OPENAI_API_KEY!);
  const knownRaw = await env.RELEASES.get(OPENAI_KNOWN_MODELS_KEY);
  if (!knownRaw) {
    if (dryRun) return `openai_models: would seed ${models.length} known (dry)`;
    await env.RELEASES.put(OPENAI_KNOWN_MODELS_KEY, JSON.stringify(models.map((m) => m.id)));
    return `openai_models: seeded ${models.length} known, nothing posted`;
  }
  const known = new Set(JSON.parse(knownRaw) as string[]);
  const fresh = models.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return "openai_models: nothing new";

  const { post, via } = await buildOpenAiModelsPost(env, fresh);
  const ids = fresh.map((m) => m.id).join(", ");
  if (dryRun) {
    console.log(`DRY_RUN: would post new OpenAI models:\n${post}`);
    return `openai_models: would post ${ids} [${via}] (dry)`;
  }
  const messageId = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MODELS_CHAT_ID!, post);
  await recordAction(env.ARCHIVE, {
    chat: env.TELEGRAM_MODELS_CHAT_ID!,
    kind: "send",
    messageId,
    text: post,
  });
  // Union-merge: a model the API stops listing for a tick must not re-announce.
  await env.RELEASES.put(
    OPENAI_KNOWN_MODELS_KEY,
    JSON.stringify([...known, ...fresh.map((m) => m.id)]),
  );
  return `openai_models: posted ${ids} [${via}]`;
}

// Each article costs a browser action or ~7.6¢, and OpenAI announces a whole
// family in one post, so a tick's worth of ids rarely needs more than one.
const MAX_ANNOUNCEMENTS_PER_POST = 2;

async function buildOpenAiModelsPost(
  env: Env,
  fresh: OpenAiModel[],
): Promise<{ post: string; via: string }> {
  let items: NewsItem[] = [];
  try {
    items = await fetchOpenAiNews();
  } catch (err) {
    // Enrichment only; the ids are the announcement.
    console.log(`openai_models: feed fetch failed, posting ids alone: ${err}`);
  }
  const found: NewsItem[] = [];
  for (const model of fresh) {
    const hit = findAnnouncement(model.id, items);
    if (hit && !found.some((f) => f.link === hit.link)) found.push(hit);
    if (found.length === MAX_ANNOUNCEMENTS_PER_POST) break;
  }
  const articles: OpenAiArticle[] = [];
  const vias: string[] = [];
  for (const [i, item] of found.entries()) {
    // Browser Run's free plan allows one quick action per 10 seconds.
    if (i > 0) await new Promise((r) => setTimeout(r, QUICK_ACTION_GAP_MS));
    const { bullets, via } = await digestOpenAiArticle(env, item);
    articles.push({ item, bullets });
    vias.push(via);
  }
  return {
    post: formatNewOpenAiModelsPost(fresh, articles),
    via: vias.length === 0 ? "ids only" : vias.join(", "),
  };
}

// The tier tunes delivery: minor posts silently, major additionally pins.
async function sendTiered(
  env: Env,
  chatId: string,
  post: string,
  tier: Tier,
  opts: { linkPreview?: boolean } = {},
): Promise<void> {
  const silent = tier === "minor";
  const messageId = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, post, {
    silent,
    ...(opts.linkPreview ? { linkPreview: true } : {}),
  });
  await recordAction(env.ARCHIVE, { chat: chatId, kind: "send", messageId, text: post, silent, tier });
  if (tier === "major") {
    // The pin is nice-to-have; the post is already out.
    try {
      await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId);
      await recordAction(env.ARCHIVE, { chat: chatId, kind: "pin", messageId });
    } catch (err) {
      console.log(`pin failed in ${chatId}: ${err}`);
    }
  }
}

/**
 * Preview: the exact message a force-post would put in the channel, delivered
 * to the owner's DM instead. No archive entry and no pin — the channel did
 * nothing; the silent flag is kept so the DM mirrors the tier's delivery.
 */
async function sendPreviewTiered(
  env: Env,
  post: string,
  tier: Tier,
  previewTo: string,
  opts: { linkPreview?: boolean } = {},
): Promise<void> {
  await sendMessage(env.TELEGRAM_BOT_TOKEN, previewTo, post, {
    silent: tier === "minor",
    ...(opts.linkPreview ? { linkPreview: true } : {}),
  });
}

const MAX_BLOG_POSTS_PER_TICK = 5;

async function watchAnthropicBlogs(env: Env, dryRun: boolean): Promise<string> {
  const entries = await fetchAllBlogEntries();
  const seenRaw = await env.RELEASES.get(ANTHROPIC_BLOG_SEEN_KEY);
  if (!seenRaw) {
    if (dryRun) return `blog: would seed ${entries.length} seen (dry)`;
    await env.RELEASES.put(ANTHROPIC_BLOG_SEEN_KEY, JSON.stringify(entries.map((e) => e.url)));
    return `blog: seeded ${entries.length} seen, nothing posted`;
  }
  const seen = new Set(JSON.parse(seenRaw) as string[]);
  // Oldest first; the cap bounds LLM calls per tick, the tail catches up next tick.
  const fresh = entries
    .filter((e) => !seen.has(e.url))
    .reverse()
    .slice(0, MAX_BLOG_POSTS_PER_TICK);
  if (fresh.length === 0) return "blog: nothing new";

  const posted: string[] = [];
  for (const entry of fresh) {
    const digest = await digestBlogPost(env.ANTHROPIC_API_KEY, env.RELEASES, entry);
    const post = formatBlogPost(entry, digest);
    if (dryRun) {
      console.log(`DRY_RUN: would post [${digest.tier}] ${entry.url}:\n${post}`);
    } else {
      await sendTiered(env, env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID!, post, digest.tier);
      seen.add(entry.url);
      await env.RELEASES.put(ANTHROPIC_BLOG_SEEN_KEY, JSON.stringify([...seen]));
    }
    posted.push(`${entry.url} [${digest.tier}]`);
  }
  return `blog: posted ${posted.join(", ")}${dryRun ? " (dry)" : ""}`;
}

/**
 * Browser first (free), then the model's own fetch (paid), then nothing but the
 * feed's own sentence. A post always goes out, only its depth degrades.
 */
async function digestOpenAiArticle(
  env: Env,
  item: NewsItem,
): Promise<{ bullets: string[]; tier: Tier; via: string }> {
  const markdown = await fetchPageMarkdown(env.BROWSER, item.link);
  if (markdown) {
    const digest = await digestArticle(
      env.ANTHROPIC_API_KEY,
      env.RELEASES,
      "OpenAI",
      item.title,
      markdown,
    );
    return { ...digest, via: "browser" };
  }
  try {
    const digest = await digestArticleByUrl(
      env.ANTHROPIC_API_KEY,
      env.RELEASES,
      "OpenAI",
      item.title,
      item.link,
    );
    return { ...digest, via: "web_fetch" };
  } catch (err) {
    console.log(`openai web_fetch digest failed for ${item.link}: ${err}`);
  }
  const tier = await classifyTier(env.ANTHROPIC_API_KEY, env.RELEASES, item);
  return { bullets: [], tier, via: "feed only" };
}

async function buildOpenAiBlogPost(
  env: Env,
  item: NewsItem,
): Promise<{ post: string; tier: Tier; via: string }> {
  const { bullets, tier, via } = await digestOpenAiArticle(env, item);
  // No bullets falls back to the feed sentence inside the formatter.
  return { post: formatOpenAiBlogPost(item, bullets), tier, via };
}

// Bounds the digests one tick can pay for; the tail catches up next tick.
const MAX_OPENAI_BLOG_PER_TICK = 8;

async function watchOpenAiBlog(env: Env, dryRun: boolean): Promise<string> {
  const items = await fetchOpenAiNews();
  const seenRaw = await env.RELEASES.get(OPENAI_BLOG_SEEN_KEY);
  if (!seenRaw) {
    if (dryRun) return `openai_blog: would seed ${items.length} seen (dry)`;
    await env.RELEASES.put(OPENAI_BLOG_SEEN_KEY, JSON.stringify(items.map((i) => i.guid)));
    return `openai_blog: seeded ${items.length} seen, nothing posted`;
  }
  const seen = new Set(JSON.parse(seenRaw) as string[]);
  const unseen = items.filter((i) => !seen.has(i.guid));
  // Backfilled history is absorbed into the seen-set without a post, so it is
  // reported once rather than reconsidered every tick.
  const now = Date.now();
  const stale = unseen.filter((i) => !isRecent(i, now));
  if (stale.length > 0 && !dryRun) {
    for (const item of stale) seen.add(item.guid);
    await env.RELEASES.put(OPENAI_BLOG_SEEN_KEY, JSON.stringify([...seen]));
  }
  const recent = unseen.filter((i) => isRecent(i, now));
  let skipped = stale.length > 0 ? `, skipped ${stale.length} backfilled` : "";
  if (recent.length === 0) {
    // A dry run is this source's health check, so it reports whether the news
    // list still answers even when there is nothing to post.
    if (!dryRun) return `openai_blog: nothing new${skipped}`;
    const { via } = await fetchNewsListSlugs(env.BROWSER);
    return `openai_blog: nothing new${skipped} (list via=${via})`;
  }

  // Only now, with something worth posting, is the list worth a request:
  // rarely enough that asking cannot arm the challenge on its own. Items it
  // does not list are left out of the seen-set, so a blocked list decides
  // nothing permanently — the age gate absorbs them a fortnight later.
  const { slugs: listed, via: listVia } = await fetchNewsListSlugs(env.BROWSER);
  const postable = recent.filter((i) => isListed(i, listed));
  const fresh = [...postable].reverse().slice(0, MAX_OPENAI_BLOG_PER_TICK);
  const unlisted = recent.length - postable.length;
  if (unlisted > 0) skipped += `, ${unlisted} not in the news list (via=${listVia})`;
  if (fresh.length === 0) return `openai_blog: nothing new${skipped}`;

  const posted: string[] = [];
  for (const [i, item] of fresh.entries()) {
    // Browser Run's free plan allows one quick action per 10 seconds, and
    // reading the list may have just spent one — otherwise the first digest of
    // the tick answers 429 and drops to the rung that costs money.
    if (i > 0 || listVia.startsWith("browser")) await new Promise((r) => setTimeout(r, QUICK_ACTION_GAP_MS));
    const { post, tier, via } = await buildOpenAiBlogPost(env, item);
    if (dryRun) {
      console.log(`DRY_RUN: would post [${tier}] OpenAI blog item:\n${post}`);
    } else {
      await sendTiered(env, env.TELEGRAM_OPENAI_BLOG_CHAT_ID!, post, tier);
      seen.add(item.guid);
      await env.RELEASES.put(OPENAI_BLOG_SEEN_KEY, JSON.stringify([...seen]));
    }
    posted.push(`${item.title} [${tier}, ${via}]`);
  }
  return `openai_blog: posted ${posted.join(" | ")}${skipped}${dryRun ? " (dry)" : ""}`;
}

// The developer half of openai.com, into the same channel as the news feed.
async function watchOpenAiDevBlog(env: Env, dryRun: boolean): Promise<string> {
  const posts = await fetchDevPosts();
  const seenRaw = await env.RELEASES.get(OPENAI_DEV_SEEN_KEY);
  if (!seenRaw) {
    if (dryRun) return `openai_dev: would seed ${posts.length} seen (dry)`;
    await env.RELEASES.put(OPENAI_DEV_SEEN_KEY, JSON.stringify(posts.map((p) => p.url)));
    return `openai_dev: seeded ${posts.length} seen, nothing posted`;
  }
  const seen = new Set(JSON.parse(seenRaw) as string[]);
  const fresh = posts.filter((p) => !seen.has(p.url)).slice(0, MAX_BLOG_POSTS_PER_TICK);
  if (fresh.length === 0) return "openai_dev: nothing new";

  const posted: string[] = [];
  for (const post of fresh) {
    const { text, tier, body } = await buildDevPost(env, post);
    if (!text) {
      console.log(`openai_dev: no text for ${post.url}, skipping until next tick`);
      continue;
    }
    if (dryRun) {
      console.log(`DRY_RUN: would post [${tier}] ${post.url}:\n${body}`);
    } else {
      await sendTiered(env, env.TELEGRAM_OPENAI_BLOG_CHAT_ID!, body, tier);
      seen.add(post.url);
      await env.RELEASES.put(OPENAI_DEV_SEEN_KEY, JSON.stringify([...seen]));
    }
    posted.push(`${post.title} [${tier}]`);
  }
  return `openai_dev: posted ${posted.length ? posted.join(" | ") : "none"}${dryRun ? " (dry)" : ""}`;
}

async function buildDevPost(
  env: Env,
  post: DevPost,
): Promise<{ text: boolean; tier: Tier; body: string }> {
  const text = await fetchDevPostText(post);
  if (!text) return { text: false, tier: "minor", body: "" };
  const digest = await digestArticle(
    env.ANTHROPIC_API_KEY,
    env.RELEASES,
    "the OpenAI developer blog",
    post.title,
    text,
  );
  return { text: true, tier: digest.tier, body: formatDevPost(post, digest.bullets) };
}

// Each company's videos land in its blog channel, next to its written posts.
function youtubeChatId(env: Env, channel: YouTubeChannel): string | undefined {
  return channel.key === "openai"
    ? env.TELEGRAM_OPENAI_BLOG_CHAT_ID
    : env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID;
}

async function watchYouTubeChannel(
  env: Env,
  channel: YouTubeChannel,
  chatId: string,
  dryRun: boolean,
): Promise<string> {
  const tag = `youtube_${channel.key}`;
  const seenKey = youtubeSeenKey(channel);
  const videos = await fetchVideoFeed(channel.channelId);
  const seenRaw = await env.RELEASES.get(seenKey);
  if (!seenRaw) {
    if (dryRun) return `${tag}: would seed ${videos.length} seen (dry)`;
    await env.RELEASES.put(seenKey, JSON.stringify(videos.map((v) => v.videoId)));
    return `${tag}: seeded ${videos.length} seen, nothing posted`;
  }
  const seen = new Set(JSON.parse(seenRaw) as string[]);
  const unseen = videos.filter((v) => !seen.has(v.videoId));
  // Resurfaced history is absorbed into the seen-set without a post.
  const now = Date.now();
  const stale = unseen.filter((v) => !isRecentVideo(v, now));
  if (stale.length > 0 && !dryRun) {
    for (const video of stale) seen.add(video.videoId);
    await env.RELEASES.put(seenKey, JSON.stringify([...seen]));
  }
  let skipped = stale.length > 0 ? `, skipped ${stale.length} stale` : "";
  // Oldest first; the cap bounds LLM calls per tick, the tail catches up next tick.
  const fresh = unseen
    .filter((v) => isRecentVideo(v, now))
    .reverse()
    .slice(0, MAX_BLOG_POSTS_PER_TICK);
  if (fresh.length === 0) return `${tag}: nothing new${skipped}`;

  const posted: string[] = [];
  let shorts = 0;
  for (const video of fresh) {
    // A Short is a promo cut of a video the channel carries in full — absorbed
    // silently, not posted.
    if (await isShort(video.videoId)) {
      shorts++;
      if (!dryRun) {
        seen.add(video.videoId);
        await env.RELEASES.put(seenKey, JSON.stringify([...seen]));
      }
      continue;
    }
    const digest = await digestVideo(env.ANTHROPIC_API_KEY, env.RELEASES, channel.label, video);
    const post = formatVideoPost(video, digest.bullets);
    if (dryRun) {
      console.log(`DRY_RUN: would post [${digest.tier}] ${video.url}:\n${post}`);
    } else {
      await sendTiered(env, chatId, post, digest.tier, { linkPreview: true });
      seen.add(video.videoId);
      await env.RELEASES.put(seenKey, JSON.stringify([...seen]));
    }
    posted.push(`${video.title} [${digest.tier}]`);
  }
  if (shorts > 0) skipped += `, ${shorts} shorts`;
  if (posted.length === 0) return `${tag}: nothing new${skipped}`;
  return `${tag}: posted ${posted.join(" | ")}${skipped}${dryRun ? " (dry)" : ""}`;
}

// Test hook /run?source=youtube&version=<title or video-id substring>, never
// touches KV. Reports whether the Shorts probe would drop the video.
async function forceYouTubeVideo(
  env: Env,
  query: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  const q = query.toLowerCase();
  for (const channel of YOUTUBE_CHANNELS) {
    const video = (await fetchVideoFeed(channel.channelId)).find(
      (v) => v.title.toLowerCase().includes(q) || v.videoId === query,
    );
    if (!video) continue;
    const short = await isShort(video.videoId);
    const digest = await digestVideo(env.ANTHROPIC_API_KEY, env.RELEASES, channel.label, video);
    const post = formatVideoPost(video, digest.bullets);
    if (previewTo) {
      await sendPreviewTiered(env, post, digest.tier, previewTo, { linkPreview: true });
      return `youtube_${channel.key}: previewed "${video.title}" [${digest.tier}] short=${short}`;
    }
    if (dryRun) {
      return `youtube_${channel.key}: "${video.title}" tier=${digest.tier} short=${short} (dry)\n---\n${post}`;
    }
    const chatId = youtubeChatId(env, channel);
    if (!chatId) return `youtube_${channel.key}: no chat configured`;
    await sendTiered(env, chatId, post, digest.tier, { linkPreview: true });
    return `youtube_${channel.key}: force-posted "${video.title}" [${digest.tier}]`;
  }
  return `youtube: no video matching ${query}`;
}

const MAX_STATUS_CARDS_PER_TICK = 5;

function followKeyboard(incident: Incident): InlineKeyboard | undefined {
  // Nothing left to follow once it's over.
  if (incident.resolved) return undefined;
  return { inline_keyboard: [[{ text: "🔔 Follow", callback_data: `sub:${incident.id}` }]] };
}

/**
 * One card per incident, edited in place as the timeline grows — the channel
 * is a board of incidents, not a stream of "we are continuing to work on a
 * fix". The only sound the channel ever makes is a high-impact incident
 * opening; everything after that is a silent edit, and whoever pressed Follow
 * gets each update loudly in DM instead.
 */
async function upsertIncidentCard(
  env: Env,
  incident: Incident,
  messageId: number,
): Promise<number> {
  const chatId = env.TELEGRAM_STATUS_CHAT_ID!;
  const token = env.TELEGRAM_STATUS_BOT_TOKEN!;
  const card = formatIncidentCard(incident);
  const keyboard = followKeyboard(incident);

  if (messageId === 0) {
    const loud = isHighImpact(incident) && !incident.resolved;
    const newId = await sendMessage(token, chatId, card, { silent: !loud, keyboard });
    await recordAction(env.ARCHIVE, { chat: chatId, kind: "send", messageId: newId, text: card, silent: !loud });
    if (loud) {
      // The pin is nice-to-have; the card is already out.
      try {
        await pinMessage(token, chatId, newId);
        await recordAction(env.ARCHIVE, { chat: chatId, kind: "pin", messageId: newId });
      } catch (err) {
        console.log(`pin failed in ${chatId}: ${err}`);
      }
    }
    return newId;
  }

  await editMessageText(token, chatId, messageId, card, { keyboard });
  await recordAction(env.ARCHIVE, { chat: chatId, kind: "edit", messageId, text: card });
  if (incident.resolved) {
    // Unconditional: impact can be raised mid-incident, and a pin left hanging
    // over a resolved incident is worse than a wasted call.
    try {
      await unpinMessage(token, chatId, messageId);
      await recordAction(env.ARCHIVE, { chat: chatId, kind: "unpin", messageId });
    } catch (err) {
      console.log(`unpin failed in ${chatId}: ${err}`);
    }
  }
  return messageId;
}

async function watchAnthropicStatus(env: Env, dryRun: boolean): Promise<string> {
  const incidents = await fetchIncidents();
  const raw = await env.RELEASES.get(STATUS_INCIDENTS_KEY);
  if (!raw) {
    if (dryRun) return `status: would seed ${incidents.length} incidents (dry)`;
    await env.RELEASES.put(STATUS_INCIDENTS_KEY, JSON.stringify(seedState(incidents)));
    return `status: seeded ${incidents.length} incidents, nothing posted`;
  }
  const stored = JSON.parse(raw) as StatusState;
  const state = pruneState(stored, incidents);
  const dropped = Object.keys(stored).length - Object.keys(state).length;

  // Oldest incident first, so a tick catching up replays history in order.
  const changed = [...incidents]
    .reverse()
    .map((incident) => ({ incident, fresh: pendingUpdates(state, incident) }))
    .filter(({ fresh }) => fresh.length > 0);
  if (changed.length === 0) {
    if (!dryRun && dropped > 0) await env.RELEASES.put(STATUS_INCIDENTS_KEY, JSON.stringify(state));
    return `status: nothing new${dropped ? `, pruned ${dropped}` : ""}`;
  }

  const posted: string[] = [];
  for (const { incident, fresh } of changed.slice(0, MAX_STATUS_CARDS_PER_TICK)) {
    const entry = state[incident.id] ?? { messageId: 0, postedUpdates: [] };
    if (dryRun) {
      console.log(`DRY_RUN: would upsert card for ${incident.name}:\n${formatIncidentCard(incident)}`);
    } else {
      entry.messageId = await upsertIncidentCard(env, incident, entry.messageId);
      // The card always renders the whole incident, so every update it shows
      // is posted — not just the ones DMed below.
      entry.postedUpdates = incident.updates.map((u) => u.id);
      state[incident.id] = entry;
      await env.RELEASES.put(STATUS_INCIDENTS_KEY, JSON.stringify(state));
      for (const update of fresh) {
        await notifySubscribers(env, incident.id, formatUpdateDm(incident, update));
      }
      if (incident.resolved) await env.RELEASES.delete(SUBS_PREFIX + incident.id);
    }
    posted.push(`${incident.name} [${incident.updates.at(-1)?.status}]`);
  }
  const capped = changed.length > MAX_STATUS_CARDS_PER_TICK ? ", capped" : "";
  return `status: updated ${posted.join(" | ")}${capped}${dryRun ? " (dry)" : ""}`;
}

// Test hook /run?source=status&version=<name or id substring>: renders one
// incident's card (dry: at every stage of its timeline), never touches KV.
async function forceStatusIncident(
  env: Env,
  query: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  const q = query.toLowerCase();
  const incident = (await fetchIncidents()).find(
    (i) => i.name.toLowerCase().includes(q) || i.id === query,
  );
  if (!incident) return `status: no incident matching ${query}`;
  if (previewTo) {
    // The card comes from the status bot, the same sender the channel sees.
    if (!env.TELEGRAM_STATUS_BOT_TOKEN) return "status: no bot token configured";
    await sendMessage(env.TELEGRAM_STATUS_BOT_TOKEN, previewTo, formatIncidentCard(incident), {
      silent: true,
    });
    return `status: previewed card for ${incident.name}`;
  }
  if (dryRun) {
    const stages = incident.updates.map((_, n) =>
      formatIncidentCard({ ...incident, resolved: false, updates: incident.updates.slice(0, n + 1) }),
    );
    stages.push(formatIncidentCard(incident));
    const dms = incident.updates.map((u) => formatUpdateDm(incident, u));
    return (
      `status: ${incident.name} [${incident.impact}]\n=== card stages\n${stages.join("\n---\n")}` +
      `\n=== subscriber DMs\n${dms.join("\n---\n")}`
    );
  }
  if (!env.TELEGRAM_STATUS_CHAT_ID) return "status: no chat configured";
  await upsertIncidentCard(env, incident, 0);
  return `status: force-posted card for ${incident.name}`;
}

// Test hook /run?source=blog&version=<url substring>: digests and (outside
// dry) posts one blog entry, never touches KV.
async function forceBlogEntry(
  env: Env,
  query: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  const q = query.toLowerCase();
  const entry = (await fetchAllBlogEntries()).find((e) => e.url.toLowerCase().includes(q));
  if (!entry) return `blog: no post matching ${query}`;
  const digest = await digestBlogPost(env.ANTHROPIC_API_KEY, env.RELEASES, entry);
  const post = formatBlogPost(entry, digest);
  if (previewTo) {
    await sendPreviewTiered(env, post, digest.tier, previewTo);
    return `blog: previewed ${entry.url} [${digest.tier}]`;
  }
  if (dryRun) return `blog: ${entry.url} tier=${digest.tier} (dry)\n---\n${post}`;
  if (!env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID) return "blog: no chat configured";
  await sendTiered(env, env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID, post, digest.tier);
  return `blog: force-posted ${entry.url} [${digest.tier}]`;
}

// Test hook /run?source=openai_blog&version=<title substring>, never touches KV.
async function forceOpenAiBlogItem(
  env: Env,
  query: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  const q = query.toLowerCase();
  const item = (await fetchOpenAiNews()).find(
    (i) => i.title.toLowerCase().includes(q) || i.guid.includes(query),
  );
  if (!item) return `openai_blog: no item matching ${query}`;
  if (previewTo) {
    const { post, tier, via } = await buildOpenAiBlogPost(env, item);
    await sendPreviewTiered(env, post, tier, previewTo);
    return `openai_blog: previewed "${item.title}" [${tier}, ${via}]`;
  }
  if (dryRun) {
    // A force-post deliberately ignores the filter; the dry run still reports
    // what the filter would have said, which is the only view we have of
    // whether the news list answers a worker at all. The list goes first, and
    // the digest waits out the quick-action gap behind it, for the same reason
    // the tick does it in that order.
    const { slugs, via: listVia } = await fetchNewsListSlugs(env.BROWSER);
    if (listVia.startsWith("browser")) await new Promise((r) => setTimeout(r, QUICK_ACTION_GAP_MS));
    const verdict = slugs ? (slugs.has(articleSlug(item.link)) ? "yes" : "no") : "unreachable";
    const { post, tier, via } = await buildOpenAiBlogPost(env, item);
    return `openai_blog: "${item.title}" tier=${tier} via=${via} list=${verdict} (via=${listVia}) category=${item.category || "-"} (dry)\n---\n${post}`;
  }
  const { post, tier } = await buildOpenAiBlogPost(env, item);
  if (!env.TELEGRAM_OPENAI_BLOG_CHAT_ID) return "openai_blog: no chat configured";
  await sendTiered(env, env.TELEGRAM_OPENAI_BLOG_CHAT_ID, post, tier);
  return `openai_blog: force-posted "${item.title}" [${tier}]`;
}

// Test hook /run?source=openai_dev&version=<title substring>, never touches KV.
async function forceDevPost(
  env: Env,
  query: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  const q = query.toLowerCase();
  const post = (await fetchDevPosts()).find((p) => p.title.toLowerCase().includes(q));
  if (!post) return `openai_dev: no post matching ${query}`;
  const { text, tier, body } = await buildDevPost(env, post);
  if (!text) return `openai_dev: could not read ${post.mdUrl}`;
  if (previewTo) {
    await sendPreviewTiered(env, body, tier, previewTo);
    return `openai_dev: previewed "${post.title}" [${tier}]`;
  }
  if (dryRun) return `openai_dev: "${post.title}" tier=${tier} (dry)\n---\n${body}`;
  if (!env.TELEGRAM_OPENAI_BLOG_CHAT_ID) return "openai_dev: no chat configured";
  await sendTiered(env, env.TELEGRAM_OPENAI_BLOG_CHAT_ID, body, tier);
  return `openai_dev: force-posted "${post.title}" [${tier}]`;
}

// Force-announce one OpenAI model (test hook /run?source=openai&version=<id>),
// never touches KV. Shows which article the id matched, if any.
async function forceOpenAiModel(
  env: Env,
  id: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  if (!env.OPENAI_API_KEY) return "openai_models: no api key configured";
  const model = (await listOpenAiModels(env.OPENAI_API_KEY)).find((m) => m.id === id) ?? {
    id,
    created: 0,
  };
  const { post, via } = await buildOpenAiModelsPost(env, [model]);
  if (previewTo) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, previewTo, post);
    return `openai_models: previewed ${id} [${via}]`;
  }
  if (dryRun) {
    console.log(`DRY_RUN: would post OpenAI model announcement:\n${post}`);
    return `openai_models: would post ${id} [${via}] (dry)\n---\n${post}`;
  }
  if (!env.TELEGRAM_MODELS_CHAT_ID) return "models: no chat configured";
  const messageId = await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MODELS_CHAT_ID, post);
  await recordAction(env.ARCHIVE, {
    chat: env.TELEGRAM_MODELS_CHAT_ID,
    kind: "send",
    messageId,
    text: post,
  });
  return `openai_models: force-posted ${id} [${via}]`;
}

// Force-announce one model (test hook /run?source=models&version=<id>), never touches KV.
async function forceModelAnnouncement(
  env: Env,
  id: string,
  dryRun: boolean,
  previewTo?: string,
): Promise<string> {
  const model = (await listModels(env.ANTHROPIC_API_KEY)).find((m) => m.id === id) ?? {
    id,
    displayName: id,
    createdAt: "",
  };
  const announcements = await buildAnnouncements(env.ANTHROPIC_API_KEY, env.RELEASES, [model]);
  const post = formatNewModelsPost(announcements);
  const photoUrls = announcements.flatMap((a) => a.press?.photos.map((p) => p.url) ?? []);
  if (previewTo) {
    await postModelsMessage(env, post, announcements, previewTo);
    return `models: previewed ${id} (photos: ${photoUrls.join(", ") || "none"})`;
  }
  if (dryRun) {
    console.log(`DRY_RUN: would post model announcement:\n${post}`);
    return `models: would post ${id} (dry, photos: ${photoUrls.join(", ") || "none"})\n---\n${post}`;
  }
  if (!env.TELEGRAM_MODELS_CHAT_ID) return "models: no chat configured";
  await postModelsMessage(env, post, announcements);
  return `models: force-posted ${id}`;
}

export async function runPipeline(
  env: Env,
  opts: { forceVersion?: string; dryOverride?: boolean; source?: string; preview?: boolean } = {},
): Promise<string> {
  const dryRun = opts.dryOverride ?? env.DRY_RUN === "1";
  const sources = feedSources(env);

  if (opts.forceVersion) {
    const previewTo = opts.preview ? env.TELEGRAM_OWNER_CHAT_ID : undefined;
    if (opts.preview && !previewTo) return "preview: TELEGRAM_OWNER_CHAT_ID not configured";
    if (opts.source === "models")
      return forceModelAnnouncement(env, opts.forceVersion, dryRun, previewTo);
    if (opts.source === "openai")
      return forceOpenAiModel(env, opts.forceVersion, dryRun, previewTo);
    if (opts.source === "blog") return forceBlogEntry(env, opts.forceVersion, dryRun, previewTo);
    if (opts.source === "openai_blog")
      return forceOpenAiBlogItem(env, opts.forceVersion, dryRun, previewTo);
    if (opts.source === "openai_dev")
      return forceDevPost(env, opts.forceVersion, dryRun, previewTo);
    if (opts.source === "youtube")
      return forceYouTubeVideo(env, opts.forceVersion, dryRun, previewTo);
    if (opts.source === "status")
      return forceStatusIncident(env, opts.forceVersion, dryRun, previewTo);
    const source = sources.find((s) => s.key === (opts.source ?? "claude"));
    if (!source) return `unknown source ${opts.source}`;
    if (!source.chatId && !dryRun && !previewTo) return `${source.key}: no chat configured`;
    const release = (await source.fetch()).find((r) => r.version === opts.forceVersion);
    if (!release) return `version ${opts.forceVersion} not found for ${source.key}`;
    await postRelease(env, source, release, dryRun, previewTo);
    if (previewTo) return `previewed ${source.key} ${release.version}`;
    return `force-posted ${source.key} ${release.version}${dryRun ? " (dry)" : ""}`;
  }

  // Sources are isolated: one failing doesn't block the rest (each has its
  // own KV cursor and catches up next tick).
  const statuses: string[] = [];
  for (const source of sources) {
    if (!source.chatId) continue;
    try {
      statuses.push(await runFeed(env, source, dryRun));
    } catch (err) {
      statuses.push(`${source.key}: failed: ${err}`);
    }
  }
  if (env.TELEGRAM_MODELS_CHAT_ID) {
    try {
      statuses.push(await watchAnthropicModels(env, dryRun));
    } catch (err) {
      statuses.push(`models: failed: ${err}`);
    }
    if (env.OPENAI_API_KEY) {
      try {
        statuses.push(await watchOpenAiModels(env, dryRun));
      } catch (err) {
        statuses.push(`openai_models: failed: ${err}`);
      }
    }
  }
  if (env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID) {
    try {
      statuses.push(await watchAnthropicBlogs(env, dryRun));
    } catch (err) {
      statuses.push(`blog: failed: ${err}`);
    }
  }
  if (env.TELEGRAM_OPENAI_BLOG_CHAT_ID) {
    try {
      statuses.push(await watchOpenAiBlog(env, dryRun));
    } catch (err) {
      statuses.push(`openai_blog: failed: ${err}`);
    }
    try {
      statuses.push(await watchOpenAiDevBlog(env, dryRun));
    } catch (err) {
      statuses.push(`openai_dev: failed: ${err}`);
    }
  }
  for (const channel of YOUTUBE_CHANNELS) {
    const chatId = youtubeChatId(env, channel);
    if (!chatId) continue;
    try {
      statuses.push(await watchYouTubeChannel(env, channel, chatId, dryRun));
    } catch (err) {
      statuses.push(`youtube_${channel.key}: failed: ${err}`);
    }
  }
  return statuses.join("\n");
}

/**
 * The status watch runs on its own schedule, so it is deliberately outside
 * runPipeline: were both ticks to carry it, the two invocations that land on
 * the same minute would race on one KV key and double-post an update.
 */
export async function runStatusTick(
  env: Env,
  opts: { dryOverride?: boolean } = {},
): Promise<string> {
  if (!env.TELEGRAM_STATUS_CHAT_ID) return "status: no chat configured";
  if (!env.TELEGRAM_STATUS_BOT_TOKEN) return "status: no bot token configured";
  const dryRun = opts.dryOverride ?? env.DRY_RUN === "1";
  try {
    return await watchAnthropicStatus(env, dryRun);
  } catch (err) {
    return `status: failed: ${err}`;
  }
}

// Incidents get the faster of the two crons in wrangler.jsonc: their median
// life is under an hour and a quarter of them are shorter than 25 minutes, so
// a 15-minute loop would routinely collapse one into a single message that
// opens and resolves at once.
const STATUS_CRON = "*/5 * * * *";

/**
 * Read-only view of the archive, behind its own token: a puller holding it can
 * read what was posted but never trigger the pipeline or post (issue #2).
 */
async function handleArchive(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  // The secret is a whitespace-separated list: one token per consumer, so one
  // can be rotated or revoked without touching the others.
  const allowed = (env.ARCHIVE_READ_SECRET ?? "").split(/\s+/).filter(Boolean);
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !allowed.includes(token)) {
    return new Response("forbidden", { status: 403 });
  }
  const photo = url.pathname.match(/^\/archive\/photo\/(\d+)\/(\d+)$/);
  if (photo) {
    const found = await readPhoto(env.ARCHIVE, Number(photo[1]), Number(photo[2]));
    if (!found) return new Response("not found", { status: 404 });
    return new Response(found.bytes, {
      headers: {
        "content-type": found.mediaType,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  }
  if (url.pathname !== "/archive") return new Response("not found", { status: 404 });
  const since = url.searchParams.get("since") ?? "0";
  if (!/^\d+$/.test(since)) return new Response("bad since\n", { status: 400 });
  return Response.json(await readActions(env.ARCHIVE, Number(since)));
}

export default {
  async scheduled(event, env, _ctx) {
    console.log(event.cron === STATUS_CRON ? await runStatusTick(env) : await runPipeline(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    // The status bot's webhook. Telegram authenticates with the secret header
    // it was registered with (setWebhook secret_token).
    if (url.pathname === "/telegram") {
      if (
        !env.STATUS_WEBHOOK_SECRET ||
        request.headers.get("x-telegram-bot-api-secret-token") !== env.STATUS_WEBHOOK_SECRET
      ) {
        return new Response("forbidden", { status: 403 });
      }
      await handleTelegramUpdate(env, await request.json());
      return new Response("ok");
    }
    if (url.pathname === "/archive" || url.pathname.startsWith("/archive/")) {
      return handleArchive(request, env, url);
    }
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    // Bearer header, not a query param: query strings end up in logs and copied URLs.
    if (request.headers.get("authorization") !== `Bearer ${env.TRIGGER_SECRET}`) {
      return new Response("forbidden", { status: 403 });
    }
    const dryOverride = url.searchParams.has("dry")
      ? url.searchParams.get("dry") === "1"
      : undefined;
    const preview = url.searchParams.get("preview") === "1";
    if (preview && !url.searchParams.get("version")) {
      return new Response("preview needs source= and version=\n", { status: 400 });
    }
    const only = url.searchParams.get("only");
    if (only && only !== "status") return new Response(`unknown only=${only}\n`, { status: 400 });
    const result = only
      ? await runStatusTick(env, { dryOverride })
      : await runPipeline(env, {
          forceVersion: url.searchParams.get("version") ?? undefined,
          source: url.searchParams.get("source") ?? undefined,
          dryOverride,
          preview,
        });
    return new Response(result + "\n");
  },
} satisfies ExportedHandler<Env>;
