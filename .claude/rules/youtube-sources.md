---
paths:
  - "src/youtube.ts"
---

# YouTube watch → the blog channels (src/youtube.ts)

YouTube Data API v3, `playlistItems.list` on the channel's uploads playlist (`UU` + channel id without `UC`) — the 15 newest uploads with full descriptions, newest first, no history; `contentDetails.videoPublishedAt` is the public date (a scheduled premiere joins the playlist earlier). One quota unit per call of the project's 10,000/day; three channels at 96 ticks/day spend ~300. Polled conditionally (etag; a 304 still costs the unit, it saves the body), validator committed only once every fresh video is posted. The key is `YOUTUBE_API_KEY` (Google Cloud project `smallbot`, key restricted to this API, Keychain `google`/`api-key-smallbot`), sent as `x-goog-api-key` so the URL — the validator key in KV — never carries it; without it the channel watches are off. **The per-channel atom feed (`feeds/videos.xml`) was dropped 2026-09-15**: no quota, but it answers 404 for every channel on the planet for hours at a time, every few days, since 2021 (newsboat #3269, glance #959, rss-bridge #2113) — two false health issues in ten days. Channel ids, resolved once from the handle page's `<link rel="canonical">`: OpenAI `UCXZCJLdBC09xxGZ6gcdrc6A` → `@openai_blogs`, Anthropic `UCrDwWp7EBBv4NwvScIpBDOA` and Claude `UCV03SRZXJEz-hchIAogeJOg` → `@anthropic_blogs`. **@claudeofficial is a squatter** ("CLAUDE" in caps); the real Claude channel is @claude.

Seen-set per channel (`youtube_seen:<key>`, JSON video-id array), first run seeds silently; the second gate is 14-day age off the public date (undated = stale), stale items absorbed into the seen-set without a post. Channels are isolated in the pipeline loop like every other source.

**Shorts are dropped, not posted** — they are promo cuts of videos the channel carries in full (measured on @claude: 2 of 6 recent uploads were Shorts duplicating a full video's title). The API doesn't mark them, but `youtube.com/shorts/<id>` answers 200 for a Short and a 303 redirect to /watch for a regular video — a fact, not an LLM guess. Probe errors count as "not a Short": the failure mode is a posted promo cut, never a dropped video. Dropped Shorts are absorbed into the seen-set.

**A batch is judged whole, and a topic is one post.** On 2026-09-01 the Claude channel uploaded ten launch demos in one minute and the channel got eleven posts in half an hour. Three rules since, all in `watchYouTubeChannel`:

- *Cooldown*: if the newest unseen video is under `MIN_VIDEO_AGE_MS` (5 min) old the channel waits a tick (`settling`), so a burst still uploading is never split across ticks. Ticks are 15 minutes apart, so a video surfaces 5–20 minutes after upload.
- *Companions*: a video whose description links to an article the company's blog channel already posted (the blog seen-sets, normalized: scheme, trailing slash, query) is not posted; it is appended to that article's post as `▶ <linked title>` via `editMessageText`, the message found in the D1 archive by its href (`findPostedMessage`). No archived post (a gap, retention) → the video is treated as standalone. Only the description→article direction is checked; an article embedding a video whose description does not link back still gets a separate post.
- *Grouping*: two or more standalone videos go to one LLM call (`groupVideos`) that splits them by topic and titles each group; a group of several becomes ONE roundup post (`formatRoundupPost`: bold topic title `· N videos on <channel>`, then the titles as links, preview off, the group's tier), a group of one keeps the per-video digest below. Invented ids are dropped, forgotten videos become groups of one — every real video posts exactly once. Cap: 5 posts per tick, the tail catches up.

Digest for a lone video: one LLM call on title + description — the video itself is never watched, the prompt says so and tells the model to leave bullets empty rather than invent. Shares `DIGEST_TASK`/`TIER_CRITERIA` with the blog watches and delivers through the same `sendTiered`.

**Post format (owner-specified)**: the bare linked title leads, no source label — and the link preview is ON for these posts only (`linkPreview: true` through `sendTiered`), because the YouTube card names the channel and shows the player; a label would duplicate it. Roundups list several videos, so their preview stays off.

Test hook: `/run?source=youtube&version=<title or video-id substring>&dry=1` — searches all three feeds, reports the tier and whether the Shorts probe would drop it.
