---
paths:
  - "src/telegram.ts"
---

# Post format and channel metadata

## Post format

HTML parse mode; header is bold with the version linked to the changelog anchor (dots stripped: `#21212`); LLM bullets use backticks which `formatInline` converts to `<code>` *after* escaping; full notes go in `<blockquote expandable>` only if the message fits ~4000 chars **and** the notes have more lines than the summary has bullets (otherwise the quote just duplicates the bullets — bit us on single-item releases), else header link suffices. No verdict line, no emoji in the header (both removed by owner request).

## Changing how posts look

A change to how posts *look* ships only after the owner has seen it: hand-send drafts via the bot API (python multipart, no LLM calls, `[TEST X]` markers, delete after), then deploy the approved variant.

Cleanup has limits, so don't plan on it: the Bipozavr bot cannot delete its own message after 48h or a service message at all, and it can't read channel history — a message id comes from the public web view, where `t.me/s/<channel>` carries `data-post="<channel>/<id>"`. The `@alfred_service_account` user account (dev-creds skill) is the way around both: as a channel admin it deletes old posts and reads history.

## Channel descriptions

Cross-reference sibling channels (set via `setChatDescription`; keep the "Bipozavr … Beep!" voice). A new channel is not done until all of it is done in one go: chat-id var, description, *every* sibling's description updated, and an avatar (docs/assets.md — it is part of standing up a channel, not a follow-up).
