---
paths:
  - "src/status.ts"
  - "src/status_bot.ts"
---

# Status watch → `@anthropic_status`

The one source with no LLM in it, and the one that runs on its own bot, `@anthropic_status_watch_bot`. Card rendering itself lives in src/index.ts.

## Feed

`status.anthropic.com` 302s to `status.claude.com`; Statuspage's `/api/v2/incidents.json` needs no key and returns the 50 most recent incidents with their full update timeline (~200KB), so one fetch is trigger *and* content — the bodies are already two terse English sentences. Updates arrive newest-first (code sorts them oldest-first) and the clock runs from `started_at`, not `created_at`. Scheduled maintenances sit behind another endpoint and are ignored: two in two years. Roughly 1.5 incidents/day, 2-6 updates each.

## Cards (src/index.ts)

One message per incident, re-rendered whole and applied with `editMessageText` on every change — 71% of Statuspage update bodies are stock phrases (the `CANNED` set in src/status.ts), so they collapse into a timeline line (`investigating → identified 16m → resolved 2h 43m`, consecutive same-status steps deduped) and only human-written text is quoted as paragraphs.

State per incident is `{messageId, postedUpdates}` (messageId 0 = seeded, first change posts a fresh card). Card pinned on open for major/critical, unpinned on resolve unconditionally (impact can be raised mid-incident, and a stuck pin is worse than a wasted call). The channel's only sound ever is a major/critical opening; edits are silent by nature. State entries vanish when the incident falls out of the 50-item window; a tick that posts nothing writes KV only if something was pruned.

Test hook: `/run?source=status&version=<name substring>&dry=1` renders the card at every stage of its timeline plus the subscriber DMs.

## Subscriptions (src/status_bot.ts)

Each card carries a `🔔 Follow` inline button (`callback_data: sub:<incident id>`; removed once resolved). Callbacks and DM commands land on the worker's `/telegram` route — `@anthropic_status_watch_bot`'s webhook, authenticated by the `X-Telegram-Bot-Api-Secret-Token` header (`STATUS_WEBHOOK_SECRET`).

Tap = toggle; the confirmation DM doubles as the reachability probe — Telegram forbids bots from opening a conversation, so an unreachable user gets `answerCallbackQuery` with a `t.me/<bot>?start=sub_<id>` deep link and the subscription arrives via the /start payload instead. Subscribers get every update as a loud DM (`formatUpdateDm`); a 403 on send (user blocked the bot) drops them.

Subs live in `status_subs:<incident id>` keys — webhook is their only writer, the cron only reads, so the two never race; the key is deleted on resolve. DM commands: `/list`, `/stop`. Bot creation/config is the manage-telegram-bot skill; token in Keychain at `telegram`/`bot-token-anthropic_status_watch_bot`, webhook secret at `webhook-secret-anthropic_status_watch_bot`.

## Its own `*/5` cron

Deliberately *outside* `runPipeline`: the two schedules coincide every 15 minutes, and two invocations racing on one KV key would double-post an update. `STATUS_CRON` in src/index.ts must match the string in wrangler.jsonc — they're matched literally, and a drift silently kills the channel (the slow tick doesn't carry status).

It posts via `TELEGRAM_STATUS_BOT_TOKEN` (secret), not Bipozavr — the bot that owns the card is the bot whose webhook gets the Follow callbacks, so the status bot must be an admin of the channel (post + edit; edit is what allows pinning).
