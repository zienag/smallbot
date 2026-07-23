import {
  ANTHROPIC_BLOG_SEEN_KEY,
  type BlogEntry,
  type Tier,
  digestBlogPost,
  fetchAllBlogEntries,
  formatBlogPost,
} from "./blogs";
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
  OPENAI_SEEN_KEY,
  classifyTier,
  fetchOpenAiNews,
  formatOpenAiModelPost,
  isModelRelease,
} from "./openai_news";
import { fetchNpmLatest } from "./npm";
import { summarize } from "./summarize";
import {
  CAPTION_LIMIT,
  buildPost,
  changelogAnchorUrl,
  pinMessage,
  sendAlbum,
  sendMessage,
} from "./telegram";
import { compareVersions } from "./version";

export interface Env {
  RELEASES: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  TRIGGER_SECRET: string;
  TELEGRAM_CHAT_ID: string;
  // A source with no channel configured is simply off.
  TELEGRAM_CODEX_CHAT_ID?: string;
  TELEGRAM_MODELS_CHAT_ID?: string;
  TELEGRAM_ANTHROPIC_BLOG_CHAT_ID?: string;
  TELEGRAM_OPENAI_BLOG_CHAT_ID?: string;
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
  if (dryRun) {
    console.log(`DRY_RUN: would post ${source.product} ${release.version} (${post.length} chars):\n${post}`);
    return;
  }
  await sendMessage(env.TELEGRAM_BOT_TOKEN, source.chatId!, post);
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
): Promise<void> {
  const photos = announcements.flatMap((a) => a.press?.photos ?? []).slice(0, 10);
  if (photos.length > 0 && post.length <= CAPTION_LIMIT) {
    try {
      await sendAlbum(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MODELS_CHAT_ID!, post, photos);
      return;
    } catch (err) {
      console.log(`album failed, falling back to plain text: ${err}`);
    }
  }
  await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MODELS_CHAT_ID!, post);
}

const MAX_CLASSIFY_PER_TICK = 8;

async function watchOpenAiNews(env: Env, dryRun: boolean): Promise<string> {
  const items = await fetchOpenAiNews();
  const seenRaw = await env.RELEASES.get(OPENAI_SEEN_KEY);
  if (!seenRaw) {
    if (dryRun) return `openai: would seed ${items.length} seen (dry)`;
    await env.RELEASES.put(OPENAI_SEEN_KEY, JSON.stringify(items.map((i) => i.guid)));
    return `openai: seeded ${items.length} seen, nothing posted`;
  }
  const seen = new Set(JSON.parse(seenRaw) as string[]);
  // Oldest first; the cap bounds LLM calls per tick, the tail catches up next tick.
  const fresh = items
    .filter((i) => !seen.has(i.guid))
    .reverse()
    .slice(0, MAX_CLASSIFY_PER_TICK);
  if (fresh.length === 0) return "openai: nothing new";

  const posted: string[] = [];
  for (const item of fresh) {
    if (await isModelRelease(env.ANTHROPIC_API_KEY, env.RELEASES, item)) {
      const post = formatOpenAiModelPost(item);
      if (dryRun) console.log(`DRY_RUN: would post OpenAI item:\n${post}`);
      else await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MODELS_CHAT_ID!, post);
      posted.push(item.title);
    }
    if (!dryRun) {
      seen.add(item.guid);
      await env.RELEASES.put(OPENAI_SEEN_KEY, JSON.stringify([...seen]));
    }
  }
  return `openai: processed ${fresh.length}, posted ${posted.length ? posted.join(" | ") : "none"}${dryRun ? " (dry)" : ""}`;
}

// The tier tunes delivery: minor posts silently, major additionally pins.
async function sendTiered(env: Env, chatId: string, post: string, tier: Tier): Promise<void> {
  const messageId = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, post, {
    silent: tier === "minor",
  });
  if (tier === "major") {
    // The pin is nice-to-have; the post is already out.
    try {
      await pinMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId);
    } catch (err) {
      console.log(`pin failed in ${chatId}: ${err}`);
    }
  }
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

async function watchOpenAiBlog(env: Env, dryRun: boolean): Promise<string> {
  const items = await fetchOpenAiNews();
  const seenRaw = await env.RELEASES.get(OPENAI_BLOG_SEEN_KEY);
  if (!seenRaw) {
    if (dryRun) return `openai_blog: would seed ${items.length} seen (dry)`;
    await env.RELEASES.put(OPENAI_BLOG_SEEN_KEY, JSON.stringify(items.map((i) => i.guid)));
    return `openai_blog: seeded ${items.length} seen, nothing posted`;
  }
  const seen = new Set(JSON.parse(seenRaw) as string[]);
  const fresh = items
    .filter((i) => !seen.has(i.guid))
    .reverse()
    .slice(0, MAX_CLASSIFY_PER_TICK);
  if (fresh.length === 0) return "openai_blog: nothing new";

  const posted: string[] = [];
  for (const item of fresh) {
    const tier = await classifyTier(env.ANTHROPIC_API_KEY, env.RELEASES, item);
    const post = formatOpenAiModelPost(item);
    if (dryRun) {
      console.log(`DRY_RUN: would post [${tier}] OpenAI blog item:\n${post}`);
    } else {
      await sendTiered(env, env.TELEGRAM_OPENAI_BLOG_CHAT_ID!, post, tier);
      seen.add(item.guid);
      await env.RELEASES.put(OPENAI_BLOG_SEEN_KEY, JSON.stringify([...seen]));
    }
    posted.push(`${item.title} [${tier}]`);
  }
  return `openai_blog: posted ${posted.join(" | ")}${dryRun ? " (dry)" : ""}`;
}

// Test hook /run?source=blog&version=<url substring>: digests and (outside
// dry) posts one blog entry, never touches KV.
async function forceBlogEntry(env: Env, query: string, dryRun: boolean): Promise<string> {
  const q = query.toLowerCase();
  const entry = (await fetchAllBlogEntries()).find((e) => e.url.toLowerCase().includes(q));
  if (!entry) return `blog: no post matching ${query}`;
  const digest = await digestBlogPost(env.ANTHROPIC_API_KEY, env.RELEASES, entry);
  const post = formatBlogPost(entry, digest);
  if (dryRun) return `blog: ${entry.url} tier=${digest.tier} (dry)\n---\n${post}`;
  if (!env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID) return "blog: no chat configured";
  await sendTiered(env, env.TELEGRAM_ANTHROPIC_BLOG_CHAT_ID, post, digest.tier);
  return `blog: force-posted ${entry.url} [${digest.tier}]`;
}

// Test hook /run?source=openai_blog&version=<title substring>, never touches KV.
async function forceOpenAiBlogItem(env: Env, query: string, dryRun: boolean): Promise<string> {
  const q = query.toLowerCase();
  const item = (await fetchOpenAiNews()).find(
    (i) => i.title.toLowerCase().includes(q) || i.guid.includes(query),
  );
  if (!item) return `openai_blog: no item matching ${query}`;
  const tier = await classifyTier(env.ANTHROPIC_API_KEY, env.RELEASES, item);
  const post = formatOpenAiModelPost(item);
  if (dryRun) return `openai_blog: "${item.title}" tier=${tier} (dry)\n---\n${post}`;
  if (!env.TELEGRAM_OPENAI_BLOG_CHAT_ID) return "openai_blog: no chat configured";
  await sendTiered(env, env.TELEGRAM_OPENAI_BLOG_CHAT_ID, post, tier);
  return `openai_blog: force-posted "${item.title}" [${tier}]`;
}

// Test hook /run?source=openai&version=<title substring>: classifies and
// (outside dry) posts one feed item, never touches KV.
async function forceOpenAiItem(env: Env, query: string, dryRun: boolean): Promise<string> {
  const q = query.toLowerCase();
  const item = (await fetchOpenAiNews()).find(
    (i) => i.title.toLowerCase().includes(q) || i.guid.includes(query),
  );
  if (!item) return `openai: no item matching ${query}`;
  const relevant = await isModelRelease(env.ANTHROPIC_API_KEY, env.RELEASES, item);
  const post = formatOpenAiModelPost(item);
  if (dryRun) return `openai: "${item.title}" → isModelRelease=${relevant} (dry)\n---\n${post}`;
  if (!relevant) return `openai: "${item.title}" is not a model release, not posting`;
  if (!env.TELEGRAM_MODELS_CHAT_ID) return "models: no chat configured";
  await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MODELS_CHAT_ID, post);
  return `openai: force-posted "${item.title}"`;
}

// Force-announce one model (test hook /run?source=models&version=<id>), never touches KV.
async function forceModelAnnouncement(env: Env, id: string, dryRun: boolean): Promise<string> {
  const model = (await listModels(env.ANTHROPIC_API_KEY)).find((m) => m.id === id) ?? {
    id,
    displayName: id,
    createdAt: "",
  };
  const announcements = await buildAnnouncements(env.ANTHROPIC_API_KEY, env.RELEASES, [model]);
  const post = formatNewModelsPost(announcements);
  const photoUrls = announcements.flatMap((a) => a.press?.photos.map((p) => p.url) ?? []);
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
  opts: { forceVersion?: string; dryOverride?: boolean; source?: string } = {},
): Promise<string> {
  const dryRun = opts.dryOverride ?? env.DRY_RUN === "1";
  const sources = feedSources(env);

  if (opts.forceVersion) {
    if (opts.source === "models") return forceModelAnnouncement(env, opts.forceVersion, dryRun);
    if (opts.source === "openai") return forceOpenAiItem(env, opts.forceVersion, dryRun);
    if (opts.source === "blog") return forceBlogEntry(env, opts.forceVersion, dryRun);
    if (opts.source === "openai_blog") return forceOpenAiBlogItem(env, opts.forceVersion, dryRun);
    const source = sources.find((s) => s.key === (opts.source ?? "claude"));
    if (!source) return `unknown source ${opts.source}`;
    if (!source.chatId && !dryRun) return `${source.key}: no chat configured`;
    const release = (await source.fetch()).find((r) => r.version === opts.forceVersion);
    if (!release) return `version ${opts.forceVersion} not found for ${source.key}`;
    await postRelease(env, source, release, dryRun);
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
    try {
      statuses.push(await watchOpenAiNews(env, dryRun));
    } catch (err) {
      statuses.push(`openai: failed: ${err}`);
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
  }
  return statuses.join("\n");
}

export default {
  async scheduled(_event, env, _ctx) {
    console.log(await runPipeline(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });
    if (url.searchParams.get("secret") !== env.TRIGGER_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const result = await runPipeline(env, {
      forceVersion: url.searchParams.get("version") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
      dryOverride: url.searchParams.has("dry")
        ? url.searchParams.get("dry") === "1"
        : undefined,
    });
    return new Response(result + "\n");
  },
} satisfies ExportedHandler<Env>;
