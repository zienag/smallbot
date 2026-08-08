---
paths:
  - "src/youtube.ts"
---

# YouTube watch → the blog channels (src/youtube.ts)

Per-channel atom feed `youtube.com/feeds/videos.xml?channel_id=…` — the 15 newest uploads with full `media:description`, no history. The feed takes only channel ids; each was resolved once from the handle page's `<link rel="canonical">`: OpenAI `UCXZCJLdBC09xxGZ6gcdrc6A` → `@openai_blogs`, Anthropic `UCrDwWp7EBBv4NwvScIpBDOA` and Claude `UCV03SRZXJEz-hchIAogeJOg` → `@anthropic_blogs`. **@claudeofficial is a squatter** ("CLAUDE" in caps); the real Claude channel is @claude.

Seen-set per channel (`youtube_seen:<key>`, JSON video-id array), first run seeds silently; the second gate is 14-day age off `<published>` (undated = stale), stale items absorbed into the seen-set without a post. Channels are isolated in the pipeline loop like every other source.

**Shorts are dropped, not posted** — they are promo cuts of videos the channel carries in full (measured on @claude: 2 of 6 recent uploads were Shorts duplicating a full video's title). The feed doesn't mark them, but `youtube.com/shorts/<id>` answers 200 for a Short and a 303 redirect to /watch for a regular video — a fact, not an LLM guess. Probe errors count as "not a Short": the failure mode is a posted promo cut, never a dropped video. Dropped Shorts are absorbed into the seen-set.

Digest: one LLM call on title + description — the video itself is never watched, the prompt says so and tells the model to leave bullets empty rather than invent. Shares `DIGEST_TASK`/`TIER_CRITERIA` with the blog watches and delivers through the same `sendTiered`.

**Post format (owner-specified)**: the bare linked title leads, no source label — and the link preview is ON for these posts only (`linkPreview: true` through `sendTiered`), because the YouTube card names the channel and shows the player; a label would duplicate it.

Test hook: `/run?source=youtube&version=<title or video-id substring>&dry=1` — searches all three feeds, reports the tier and whether the Shorts probe would drop it.
