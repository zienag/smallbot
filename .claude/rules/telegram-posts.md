---
paths:
  - "src/telegram.ts"
---

# Post format and channel metadata

## Post format

HTML parse mode; header is bold with the version linked to the changelog anchor (dots stripped: `#21212`); LLM bullets use backticks which `formatInline` converts to `<code>` *after* escaping; full notes go in `<blockquote expandable>` only if the message fits ~4000 chars **and** the notes have more lines than the summary has bullets (otherwise the quote just duplicates the bullets — bit us on single-item releases), else header link suffices. No verdict line, no emoji in the header (both removed by owner request). Link previews are disabled on every post except YouTube videos, where the card is the content (`linkPreview` in `sendMessage`).

Article posts — both blog channels, every source in them — share `buildArticlePost` (src/blogs.ts): bold linked title, bullets, then an italic footer `<source> · <n> min read`. The title leads and the source signs off at the bottom; Telegram's HTML has no colour, so italic is the quietest register the Bot API offers (`<b> <i> <u> <s> <tg-spoiler> <a> <code> <pre> <blockquote>` and nothing else). Read time is counted from the article text the digest already fetched — 220 wpm, floor 1 minute — and the whole `· n min read` half disappears when only the model saw the page (`digestArticleByUrl`); it is never inferred. YouTube videos are the exception: no footer, because the preview card already names the channel.

## Changing how posts look

A change to how posts *look* ships only after the owner has seen it: `/run?source=…&version=…&preview=1` sends the exact rendered message to his DM (docs/operations.md) — iterate there, then deploy the approved variant. Remember the ~1-minute stale-serve window after a deploy: the first preview may still come from the old version.

Cleanup has limits, so don't plan on it: the Bipozavr bot cannot delete its own message after 48h or a service message at all, and it can't read channel history — a message id comes from the public web view, where `t.me/s/<channel>` carries `data-post="<channel>/<id>"`. The `@alfred_service_account` user account (dev-creds skill) is the way around both: as a channel admin it deletes old posts and reads history.

## Channel descriptions

Cross-reference sibling channels (set via `setChatDescription`; keep the "Bipozavr … Beep!" voice). A new channel is not done until all of it is done in one go: chat-id var, description, *every* sibling's description updated, and an avatar (docs/assets.md — it is part of standing up a channel, not a follow-up).
